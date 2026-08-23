import { describe, expect, mock, test } from "bun:test"
import type { ManagedScriptLifecycle } from "@/hooks/managed_script_lifecycle"
import type { ManagedScriptRuntime } from "@/utils/managed_script_runtime"
import { createAutocodeScriptServiceTool, type ManagedScriptServiceRuntimeFactory } from "./autocode_script_service"
import { createToolContext } from "./test_context"

function parse(result: string | { output: string }): Record<string, unknown> {
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function createRuntime(overrides: Partial<ManagedScriptRuntime> = {}): ManagedScriptRuntime {
    return {
        run: mock(async () => ({ exit_code: 0, stdout: "", stderr: "", duration_ms: 1, log_path: "/logs/run.log", timed_out: false, stdout_truncated: false, stderr_truncated: false })),
        start: mock(async () => ({ run_id: "run-1", stdout_log_path: "/logs/stdout.log", stderr_log_path: "/logs/stderr.log" })),
        status: mock(async () => ({ run_id: "run-1", running: true as const, entry: "server.mjs", argv: ["--port", "3000"], started_at: "2026-08-22T00:00:00.000Z", stdout_log_path: "/logs/stdout.log", stderr_log_path: "/logs/stderr.log" })),
        stop: mock(async () => ({ run_id: "run-1", stopped: true as const })),
        cleanup: mock(async () => ({ stopped_run_ids: [], finalized_run_ids: [] })),
        ...overrides,
    }
}

function createLifecycle(): ManagedScriptLifecycle {
    return {
        registerStart: mock((): void => {}),
        handleEvent: mock(async (): Promise<void> => {}),
        dispose: mock(async (): Promise<void> => {}),
    }
}

describe("autocode_script_service tool", () => {
    test("defines managed script service schema", () => {
        const tool = createAutocodeScriptServiceTool() as unknown as { args: Record<string, unknown> }

        expect(Object.keys(tool.args)).toEqual(["action", "entry", "argv", "run_id"])
    })

    test("stops service by run ID", async () => {
        const runId = "run-owned-after-port-reuse"
        const runtime = createRuntime({
            stop: mock(async ({ run_id }: { run_id: string }) => ({ run_id, stopped: true as const })),
        })
        const tool = createAutocodeScriptServiceTool(undefined, {}, mock(() => runtime)) as unknown as {
            args: Record<string, unknown>
            description: string
            execute: (args: never, context: ReturnType<typeof createToolContext>) => Promise<string | { output: string }>
        }

        const stop = await tool.execute(
            { action: "stop", run_id: runId } as never,
            createToolContext(),
        )

        expect(Object.keys(tool.args)).not.toContain("observed_ports")
        expect(parse(stop)).toEqual({ run_id: runId, stopped: true })
        expect(runtime.stop).toHaveBeenCalledWith({ run_id: runId })
    })

    test("dispatches start, status, and stop to runtime methods", async () => {
        const order: string[] = []
        const startResult = { run_id: "run-1", stdout_log_path: "/logs/stdout.log", stderr_log_path: "/logs/stderr.log" }
        const runtime = createRuntime({
            start: mock(async () => {
                order.push("start")
                return startResult
            }),
        })
        const factory: ManagedScriptServiceRuntimeFactory = mock(() => runtime)
        const lifecycle = createLifecycle()
        lifecycle.registerStart = mock((): void => {
            order.push("register-start")
        })
        const tool = createAutocodeScriptServiceTool(undefined, {}, factory, lifecycle)
        const context = createToolContext({
            sessionID: "owned-session",
            directory: "/workspace/owned",
            worktree: "/workspace",
        })
        const start = await tool.execute({ action: "start", entry: "task.mjs", argv: ["--port", "3000"] }, context)
        await tool.execute({ action: "start", entry: "nested/task.mjs" }, context)
        const status = await tool.execute({ action: "status", run_id: "run-1" }, createToolContext())
        const stop = await tool.execute({ action: "stop", run_id: "run-1" }, createToolContext())

        expect(parse(start)).toEqual(startResult)
        expect(parse(status)).toMatchObject({ run_id: "run-1", running: true })
        expect(parse(stop)).toEqual({ run_id: "run-1", stopped: true })
        expect(runtime.start).toHaveBeenNthCalledWith(1, { entry: "task.mjs", argv: ["--port", "3000"] })
        expect(runtime.start).toHaveBeenNthCalledWith(2, { entry: "nested/task.mjs" })
        expect(runtime.status).toHaveBeenCalledWith({ run_id: "run-1" })
        expect(runtime.stop).toHaveBeenCalledWith({ run_id: "run-1" })
        expect(lifecycle.registerStart).toHaveBeenCalledTimes(2)
        expect(lifecycle.registerStart).toHaveBeenCalledWith(
            context,
            startResult,
            context.abort,
        )
        expect(order).toEqual(["start", "register-start", "start", "register-start"])
    })

    test("requires and isolates action-specific fields without creating runtime", async () => {
        const factory: ManagedScriptServiceRuntimeFactory = mock(() => { throw new Error("must not create") })
        const lifecycle = createLifecycle()
        const tool = createAutocodeScriptServiceTool(undefined, {}, factory, lifecycle)

        for (const input of [
            { action: "start" },
            { action: "start", entry: "server.mjs", run_id: "run-1" },
            { action: "start", entry: "src/server.mjs" },
            { action: "start", entry: "/outside/server.mjs" },
            { action: "start", entry: "C:\\outside\\server.mjs" },
            { action: "start", entry: "nested\\server.mjs" },
            { action: "start", entry: "nested/../server.mjs" },
            { action: "start", entry: "server.js" },
            { action: "status" },
            { action: "stop" },
            { action: "status", run_id: "run-1", entry: "server.mjs" },
            { action: "status", run_id: "run-1", argv: ["--inspect"] },
            { action: "stop", run_id: "run-1", entry: "server.mjs" },
            { action: "stop", run_id: "run-1", argv: ["--force"] },
            { action: "restart", run_id: "run-1" } as never,
        ]) {
            const response = parse(await tool.execute(input as never, createToolContext()))

            expect(response).toMatchObject({ ok: false, status: "blocked", failedAction: "manage managed script service", blocker: { code: "validation_error" } })
        }
        expect(factory).not.toHaveBeenCalled()
        expect(lifecycle.registerStart).not.toHaveBeenCalled()
    })

    test("returns service failure when factory or runtime throws", async () => {
        const factoryThrowing: ManagedScriptServiceRuntimeFactory = mock(() => { throw new Error("factory denied") })
        const runtimeThrowing = createRuntime({ start: mock(async () => { throw new Error("runtime denied") }) })
        const runtimeFactory: ManagedScriptServiceRuntimeFactory = mock(() => runtimeThrowing)
        const factoryLifecycle = createLifecycle()
        const runtimeLifecycle = createLifecycle()
        const factoryResponse = parse(await createAutocodeScriptServiceTool(undefined, {}, factoryThrowing, factoryLifecycle).execute({ action: "start", entry: "server.mjs" }, createToolContext()))
        const runtimeResponse = parse(await createAutocodeScriptServiceTool(undefined, {}, runtimeFactory, runtimeLifecycle).execute({ action: "start", entry: "server.mjs" }, createToolContext()))

        expect(factoryResponse).toMatchObject({ ok: false, status: "failed", failedAction: "manage managed script service" })
        expect(runtimeResponse).toMatchObject({ ok: false, status: "failed", failedAction: "manage managed script service" })
        expect(String(factoryResponse.error)).toContain("factory denied")
        expect(String(runtimeResponse.error)).toContain("runtime denied")
        expect(factoryLifecycle.registerStart).not.toHaveBeenCalled()
        expect(runtimeLifecycle.registerStart).not.toHaveBeenCalled()
    })
})
