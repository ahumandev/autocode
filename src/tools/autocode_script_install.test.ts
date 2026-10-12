import { describe, expect, mock, test } from "bun:test"
import { join } from "node:path"
import { createManagedScriptProjectPaths, type ManagedScriptProject, type ManagedScriptProjectDependencies, type ManagedScriptProjectResult, type ManagedScriptProjectVerifyResult } from "@/utils/managed_script_project"
import { createAutocodeScriptInstallTool, type ManagedScriptProjectFactory } from "./autocode_script_install"
import { createToolContext } from "./test_context"

const directory = "C:\\Users\\qxz13vb\\AppData\\Local\\Temp\\opencode\\script-install-wrapper"
const paths = createManagedScriptProjectPaths(directory, "job_1")
const npmLogPath = join(paths.logsRoot, "npm.log")

function parse(result: string | { output: string }): Record<string, unknown> {
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function successfulResult(): Extract<ManagedScriptProjectResult, { ok: true }> {
    return { ok: true, paths, dependencies: [], npm: { exitCode: 0, stdout: "installed", stderr: "", command: ["install"], logPath: npmLogPath } }
}

function createFactory(result: ManagedScriptProjectResult): { factory: ManagedScriptProjectFactory, project: ManagedScriptProject } {
    const project: ManagedScriptProject = {
        setup: mock(async (): Promise<ManagedScriptProjectResult> => result),
        install: mock(async (): Promise<ManagedScriptProjectResult> => result),
        verify: mock(async (): Promise<ManagedScriptProjectVerifyResult> => ({ ok: true })),
    }
    return { factory: mock((_dependencies: ManagedScriptProjectDependencies) => project), project }
}

describe("autocode_script_install tool", () => {
    test("exposes only dependencies and upgrade in managed install schema", (): void => {
        const tool = createAutocodeScriptInstallTool() as unknown as { args: Record<string, unknown> }

        expect(Object.keys(tool.args)).toEqual(["dependencies", "upgrade"])
    })

    test("returns standard validation failure without creating project", async (): Promise<void> => {
        const factory = mock((_dependencies: ManagedScriptProjectDependencies) => { throw new Error("must not create") })
        const tool = createAutocodeScriptInstallTool(undefined, {}, factory)

        for (const input of [{ dependencies: [] }, { upgrade: "true" }, { upgrade: 1 }, { upgrade: null }]) {
            const response = parse(await tool.execute(input as never, createToolContext()))

            expect(response).toMatchObject({ ok: false, status: "blocked", failedAction: "install managed scripts dependencies", blocker: { code: "validation_error" } })
            expect(typeof response.error).toBe("string")
            expect(typeof response.instruction).toBe("string")
        }
        expect(factory).not.toHaveBeenCalled()
    })

    test("omits script_file and defaults upgrade to false with optional dependencies", async (): Promise<void> => {
        const { factory, project } = createFactory(successfulResult())
        const tool = createAutocodeScriptInstallTool(undefined, {}, factory) as unknown as { args: Record<string, unknown>, execute: (args: never, context: ReturnType<typeof createToolContext>) => Promise<string | { output: string }> }
        const context = createToolContext({ directory })
        const response = parse(await tool.execute({ dependencies: { zod: "^3.0.0" }, script_file: "/caller/controlled-source.mjs" } as never, context))
        await tool.execute({} as never, context)
        await tool.execute({ dependencies: {} } as never, context)

        expect(response).toMatchObject({ ok: true, status: "installed", workspace_path: directory, project_path: paths.scriptsRoot, source_path: paths.sourceRoot, manifest_path: paths.manifestPath, lock_path: paths.lockfilePath, node_modules_path: paths.nodeModulesPath, logs_path: paths.logsRoot, npm_log_path: npmLogPath })
        expect(tool.args).not.toHaveProperty("script_file")
        expect(project.install).toHaveBeenNthCalledWith(1, { dependencies: { zod: "^3.0.0" }, upgrade: false })
        expect(project.install).toHaveBeenNthCalledWith(2, { upgrade: false })
        expect(project.install).toHaveBeenNthCalledWith(3, { dependencies: {}, upgrade: false })
        expect(project.setup).not.toHaveBeenCalled()
        expect(project.verify).not.toHaveBeenCalled()
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({ context }))
    })

    test.each([true, false])("forwards explicit upgrade %s with optional dependencies", async (upgrade: boolean): Promise<void> => {
        const { factory, project } = createFactory(successfulResult())
        const tool = createAutocodeScriptInstallTool(undefined, {}, factory)
        const context = createToolContext({ directory })
        const response = parse(await tool.execute({ dependencies: { zod: "^3.0.0" }, upgrade }, context))
        await tool.execute({ upgrade }, context)

        expect(response).toMatchObject({ ok: true, status: "installed" })
        expect(project.install).toHaveBeenNthCalledWith(1, { dependencies: { zod: "^3.0.0" }, upgrade })
        expect(project.install).toHaveBeenNthCalledWith(2, { upgrade })
    })

    test("maps core blockers and failures to install JSON", async () => {
        const blocked = createFactory({ ok: false, paths, blocker: { code: "runtime_unavailable", message: "Need Node." } })
        const failed = createFactory({ ok: false, paths, error: { code: "dependency_incompatible", message: "wrong version" } })
        const blockedResponse = parse(await createAutocodeScriptInstallTool(undefined, {}, blocked.factory).execute({}, createToolContext({ directory })))
        const failedResponse = parse(await createAutocodeScriptInstallTool(undefined, {}, failed.factory).execute({}, createToolContext({ directory })))

        expect(blockedResponse).toMatchObject({ ok: false, status: "blocked", blocker: { code: "runtime_unavailable" }, lock_path: paths.lockfilePath })
        expect(failedResponse).toMatchObject({ ok: false, status: "failed", failure: { code: "dependency_incompatible" }, node_modules_path: paths.nodeModulesPath })
        expect(typeof blockedResponse.instruction).toBe("string")
        expect(typeof failedResponse.error).toBe("string")
    })

    test("aborts JSON response when factory or install throws", async () => {
        const factoryThrowing = mock((_dependencies: ManagedScriptProjectDependencies) => { throw new Error("factory denied") })
        const installThrowing: ManagedScriptProject = {
            setup: mock(async (): Promise<ManagedScriptProjectResult> => successfulResult()),
            install: mock(async (): Promise<ManagedScriptProjectResult> => { throw new Error("install denied") }),
            verify: mock(async (): Promise<ManagedScriptProjectVerifyResult> => ({ ok: true })),
        }
        const installFactory = mock((_dependencies: ManagedScriptProjectDependencies) => installThrowing)
        const factoryResponse = parse(await createAutocodeScriptInstallTool(undefined, {}, factoryThrowing).execute({}, createToolContext()))
        const installResponse = parse(await createAutocodeScriptInstallTool(undefined, {}, installFactory).execute({}, createToolContext()))

        expect(factoryResponse).toMatchObject({ ok: false, status: "failed", failedAction: "install managed scripts dependencies" })
        expect(installResponse).toMatchObject({ ok: false, status: "failed", failedAction: "install managed scripts dependencies" })
        expect(String(factoryResponse.error)).toContain("factory denied")
        expect(String(installResponse.error)).toContain("install denied")
    })
})
