import { describe, expect, mock, test } from "bun:test"
import { join } from "node:path"
import { createManagedScriptProjectPaths, type ManagedScriptProject, type ManagedScriptProjectOwnerResolution, type ManagedScriptProjectResult, type ManagedScriptProjectVerifyResult } from "@/utils/managed_script_project"
import type { ManagedScriptRunResult, ManagedScriptRuntime } from "@/utils/managed_script_runtime"
import { createAutocodeScriptRunTool, type ManagedScriptRuntimeFactory } from "./autocode_script_run"
import { createToolContext } from "./test_context"

const directory = "C:\\Users\\qxz13vb\\AppData\\Local\\Temp\\opencode\\script-run-wrapper"
const paths = createManagedScriptProjectPaths(directory, "job_1")
const serviceLogs = { stdout_log_path: join(paths.logsRoot, "stdout.log"), stderr_log_path: join(paths.logsRoot, "stderr.log") }

function parse(result: string | { output: string }): Record<string, unknown> {
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function createRuntime(run: ManagedScriptRuntime["run"]): ManagedScriptRuntime {
    return {
        run,
        start: mock(async (): ReturnType<ManagedScriptRuntime["start"]> => ({ owner: Object.freeze({ jobName: paths.jobName, directory, sessionID: "session-1" }), run_id: "run-1", ...serviceLogs })),
        status: mock(async (): ReturnType<ManagedScriptRuntime["status"]> => ({ run_id: "run-1", running: true, entry: "server.mjs", argv: [], started_at: "2026-08-22T00:00:00.000Z", ...serviceLogs })),
        stop: mock(async () => ({ run_id: "run-1", stopped: true as const })),
        cleanup: mock(async () => ({ stopped_run_ids: [], finalized_run_ids: [] })),
    }
}

describe("autocode_script_run tool", () => {
    test("preserves only entry, argv, and timeout_ms in managed script run schema", (): void => {
        const tool = createAutocodeScriptRunTool() as unknown as { args: Record<string, unknown> }

        expect(Object.keys(tool.args)).toEqual(["entry", "argv", "timeout_ms"])
    })

    test("maps job-source-relative entries, argv, and timeout_ms to runtime run", async (): Promise<void> => {
        const result: ManagedScriptRunResult = { exit_code: 0, stdout: "done", stderr: "", duration_ms: 12, log_path: join(paths.logsRoot, "run.log"), timed_out: false, stdout_truncated: false, stderr_truncated: false }
        const runtime = createRuntime(mock(async (): Promise<ManagedScriptRunResult> => result))
        const factory: ManagedScriptRuntimeFactory = mock(() => runtime)
        const now = (): number => 1
        const tool = createAutocodeScriptRunTool(undefined, { now }, factory)
        const context = createToolContext({ directory })
        const response = await tool.execute({ entry: "task.mjs", argv: ["--input", "data"], timeout_ms: 456 }, context)
        await tool.execute({ entry: "nested/task.mjs" }, context)

        expect(response).toBe(JSON.stringify(result))
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({ now, context }))
        expect(runtime.run).toHaveBeenNthCalledWith(1, { entry: "task.mjs", argv: ["--input", "data"], timeoutMs: 456 })
        expect(runtime.run).toHaveBeenNthCalledWith(2, { entry: "nested/task.mjs" })
    })

    test("fails readiness verification without setup or install", async (): Promise<void> => {
        const project: ManagedScriptProject = {
            setup: mock(async (): Promise<ManagedScriptProjectResult> => { throw new Error("must not setup") }),
            install: mock(async (): Promise<ManagedScriptProjectResult> => { throw new Error("must not install") }),
            verify: mock(async (): Promise<ManagedScriptProjectVerifyResult> => ({ ok: false, paths, blocker: { code: "project_not_initialized", message: "Prepare shared project." } })),
        }
        const tool = createAutocodeScriptRunTool(undefined, {
            project,
            resolveOwner: async (): Promise<ManagedScriptProjectOwnerResolution> => ({ ok: true, owner: { jobName: paths.jobName, directory } }),
        })
        const response = parse(await tool.execute({ entry: "task.mjs" }, createToolContext({ directory })))

        expect(response).toMatchObject({ ok: false, status: "failed", failedAction: "run managed script" })
        expect(String(response.error)).toContain("Prepare shared project.")
        expect(project.verify).toHaveBeenCalledWith()
        expect(project.setup).not.toHaveBeenCalled()
        expect(project.install).not.toHaveBeenCalled()
    })

    test("blocks invalid schema and path fields without creating runtime", async () => {
        const factory: ManagedScriptRuntimeFactory = mock(() => { throw new Error("must not create") })
        const tool = createAutocodeScriptRunTool(undefined, {}, factory)

        for (const input of [
            {} as never,
            { entry: "src/task.mjs" },
            { entry: "/outside/task.mjs" },
            { entry: "C:\\outside\\task.mjs" },
            { entry: "nested\\task.mjs" },
            { entry: "nested/../task.mjs" },
            { entry: "task.js" },
            { entry: "task.mjs", argv: [1] } as never,
            { entry: "task.mjs", timeout_ms: 0 },
        ]) {
            const response = parse(await tool.execute(input as never, createToolContext()))

            expect(response).toMatchObject({ ok: false, status: "blocked", failedAction: "run managed script", blocker: { code: "validation_error" } })
        }
        expect(factory).not.toHaveBeenCalled()
    })

    test("returns run managed script failure when factory or runtime throws", async () => {
        const factoryThrowing: ManagedScriptRuntimeFactory = mock(() => { throw new Error("factory denied") })
        const runtimeThrowing = createRuntime(mock(async () => { throw new Error("runtime denied") }))
        const runtimeFactory: ManagedScriptRuntimeFactory = mock(() => runtimeThrowing)
        const factoryResponse = parse(await createAutocodeScriptRunTool(undefined, {}, factoryThrowing).execute({ entry: "task.mjs" }, createToolContext()))
        const runtimeResponse = parse(await createAutocodeScriptRunTool(undefined, {}, runtimeFactory).execute({ entry: "task.mjs" }, createToolContext()))

        expect(factoryResponse).toMatchObject({ ok: false, status: "failed", failedAction: "run managed script" })
        expect(runtimeResponse).toMatchObject({ ok: false, status: "failed", failedAction: "run managed script" })
        expect(String(factoryResponse.error)).toContain("factory denied")
        expect(String(runtimeResponse.error)).toContain("runtime denied")
    })
})
