import { describe, expect, mock, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ManagedScriptLifecycle } from "@/hooks/managed_script_lifecycle"
import { createManagedScriptProjectPaths, type ManagedScriptProject, type ManagedScriptProjectOwnerResolution, type ManagedScriptProjectResult, type ManagedScriptProjectVerifyResult } from "@/utils/managed_script_project"
import type { ManagedScriptLaunchOwner, ManagedScriptRuntime, ManagedScriptServiceStartResult } from "@/utils/managed_script_runtime"
import { ManagedScriptWindowsError, windowsServiceMessage } from "@/utils/managed_script_windows"
import { createAutocodeScriptServiceTool, type ManagedScriptServiceRuntimeFactory } from "./autocode_script_service"
import { createToolContext } from "./test_context"

const directory = join(tmpdir(), "script-service-wrapper")
const paths = createManagedScriptProjectPaths(directory, "job_1")
const launchOwner: ManagedScriptLaunchOwner = Object.freeze({ jobName: paths.jobName, directory, sessionID: "owned-session" })
const serviceLogs = { stdout_log_path: join(paths.logsRoot, "stdout.log"), stderr_log_path: join(paths.logsRoot, "stderr.log") }

function parse(result: string | { output: string }): Record<string, unknown> {
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function createRuntime(overrides: Partial<ManagedScriptRuntime> = {}): ManagedScriptRuntime {
    return {
        run: mock(async (): ReturnType<ManagedScriptRuntime["run"]> => ({ exit_code: 0, stdout: "", stderr: "", duration_ms: 1, log_path: join(paths.logsRoot, "run.log"), timed_out: false, stdout_truncated: false, stderr_truncated: false })),
        start: mock(async (): Promise<ManagedScriptServiceStartResult> => ({ owner: launchOwner, run_id: "run-1", ...serviceLogs })),
        status: mock(async (): ReturnType<ManagedScriptRuntime["status"]> => ({ run_id: "run-1", running: true, entry: "server.mjs", argv: ["--port", "3000"], started_at: "2026-08-22T00:00:00.000Z", ...serviceLogs })),
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
    test("preserves only action, entry, argv, and run_id in managed script service schema", (): void => {
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

    test("dispatches start, status, and stop with immutable launch owner registration", async (): Promise<void> => {
        const order: string[] = []
        const publicStartResult = { run_id: "run-1", ...serviceLogs, observed_ports: [3000] }
        const startResult: ManagedScriptServiceStartResult = { owner: launchOwner, ...publicStartResult }
        const runtime = createRuntime({
            start: mock(async (): Promise<ManagedScriptServiceStartResult> => {
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
            sessionID: launchOwner.sessionID,
            directory,
            worktree: "/workspace",
        })
        const start = await tool.execute({ action: "start", entry: "task.mjs", argv: ["--port", "3000"] }, context)
        await tool.execute({ action: "start", entry: "nested/task.mjs" }, context)
        const status = await tool.execute({ action: "status", run_id: "run-1" }, createToolContext())
        const stop = await tool.execute({ action: "stop", run_id: "run-1" }, createToolContext())

        expect(parse(start)).toEqual(publicStartResult)
        expect(parse(status)).toMatchObject({ run_id: "run-1", running: true })
        expect(parse(stop)).toEqual({ run_id: "run-1", stopped: true })
        expect(runtime.start).toHaveBeenNthCalledWith(1, { entry: "task.mjs", argv: ["--port", "3000"] })
        expect(runtime.start).toHaveBeenNthCalledWith(2, { entry: "nested/task.mjs" })
        expect(runtime.status).toHaveBeenCalledWith({ run_id: "run-1" })
        expect(runtime.stop).toHaveBeenCalledWith({ run_id: "run-1" })
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({ context }))
        expect(Object.isFrozen(startResult.owner)).toBe(true)
        expect(lifecycle.registerStart).toHaveBeenCalledTimes(2)
        expect(lifecycle.registerStart).toHaveBeenCalledWith(
            context,
            startResult,
            context.abort,
        )
        expect(order).toEqual(["start", "register-start", "start", "register-start"])
    })

    test.each(["linux", "win32", "darwin"] as const)("keeps service actions Linux-only with read-only start verification on %s", async (platform: NodeJS.Platform): Promise<void> => {
        const project: ManagedScriptProject = {
            setup: mock(async (): Promise<ManagedScriptProjectResult> => { throw new Error("must not setup") }),
            install: mock(async (): Promise<ManagedScriptProjectResult> => { throw new Error("must not install") }),
            verify: mock(async (): Promise<ManagedScriptProjectVerifyResult> => ({ ok: false, paths, blocker: { code: "project_not_initialized", message: "Prepare shared project." } })),
        }
        const spawn = mock((): never => { throw new Error("must not spawn") })
        const lifecycle = createLifecycle()
        const tool = createAutocodeScriptServiceTool(undefined, {
            project,
            resolveOwner: async (): Promise<ManagedScriptProjectOwnerResolution> => ({ ok: true, owner: { jobName: paths.jobName, directory } }),
            process: { execPath: "node", env: {}, platform, spawn, kill: mock((): void => {}) },
        }, undefined, lifecycle)
        const actions = platform === "linux" ? ["start"] as const : ["start", "status", "stop"] as const
        for (const action of actions) {
            const response = parse(await tool.execute(
                action === "start" ? { action, entry: "server.mjs" } : { action, run_id: "run-1" },
                createToolContext({ directory }),
            ))

            expect(response).toMatchObject({ ok: false, status: "failed", failedAction: "manage managed script service" })
            if (platform === "linux") {
                expect(String(response.error)).toContain("Prepare shared project.")
                expect(project.verify).toHaveBeenCalledWith()
            }
            else {
                expect(response.error).toBe("Managed script services are supported only on Linux.")
                expect(project.verify).not.toHaveBeenCalled()
            }
        }
        expect(project.setup).not.toHaveBeenCalled()
        expect(project.install).not.toHaveBeenCalled()
        expect(spawn).not.toHaveBeenCalled()
        expect(lifecycle.registerStart).not.toHaveBeenCalled()
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

    test("preserves Windows policy and forced cleanup metadata without changing caller parameters", async (): Promise<void> => {
        const windows_cleanup = { termination: "forced" as const, tree_cleanup: "best_effort" as const, descendants: "unknown" as const, root_exited: true }
        const runtime = createRuntime({
            start: mock(async (): Promise<ManagedScriptServiceStartResult> => ({ owner: launchOwner, run_id: "run-1", ...serviceLogs, message: windowsServiceMessage })),
            stop: mock(async (): ReturnType<ManagedScriptRuntime["stop"]> => ({ run_id: "run-1", stopped: true, windows_cleanup })),
        })
        const tool = createAutocodeScriptServiceTool(undefined, {}, mock(() => runtime))
        expect(parse(await tool.execute({ action: "start", entry: "server.mjs" }, createToolContext()))).toMatchObject({ run_id: "run-1", message: windowsServiceMessage })
        expect(parse(await tool.execute({ action: "stop", run_id: "run-1" }, createToolContext()))).toEqual({ run_id: "run-1", stopped: true, windows_cleanup })
    })

    test("returns structured safe refusal instead of stopped for a missing Windows root", async (): Promise<void> => {
        const windows_cleanup = { termination: "none" as const, tree_cleanup: "not_attempted" as const, descendants: "unknown" as const, root_exited: true }
        const runtime = createRuntime({ stop: mock(async (): Promise<never> => { throw new ManagedScriptWindowsError("windows_root_missing", "Root exited; live descendants may remain.", windows_cleanup) }) })
        const tool = createAutocodeScriptServiceTool(undefined, {}, mock(() => runtime))
        const result = parse(await tool.execute({ action: "stop", run_id: "run-1" }, createToolContext()))
        expect(result).toMatchObject({ ok: false, status: "failed", failedAction: "manage managed script service", code: "windows_root_missing", windows_cleanup })
        expect(result).not.toHaveProperty("stopped")
        expect(typeof result.error).toBe("string")
        expect(typeof result.instruction).toBe("string")
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
