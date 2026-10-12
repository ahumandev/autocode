import { describe, expect, mock, test } from "bun:test"
import { basename, join } from "node:path"
import { createManagedScriptProjectPaths, type ManagedScriptProject, type ManagedScriptProjectDependencies, type ManagedScriptProjectResult, type ManagedScriptProjectVerifyResult } from "@/utils/managed_script_project"
import { createAutocodeScriptProjectTool, type ManagedScriptProjectFactory } from "./autocode_script_project"
import { createToolContext } from "./test_context"

const directory = "C:\\Users\\qxz13vb\\AppData\\Local\\Temp\\opencode\\script-project-wrapper"
const paths = createManagedScriptProjectPaths(directory, "job_1")
const npmLogPath = join(paths.logsRoot, "npm.log")

const publicPaths = {
    workspace_path: paths.directory,
    project_path: paths.scriptsRoot,
    source_path: paths.sourceRoot,
    logs_path: paths.logsRoot,
    services_path: paths.servicesRoot,
}

function parse(result: string | { output: string }): Record<string, unknown> {
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function expectPublicPathKeys(response: Record<string, unknown>): void {
    expect(Object.keys(response).filter((key: string): boolean => key.endsWith("_path")).sort()).toEqual(Object.keys(publicPaths).sort())
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

describe("autocode_script_project tool", () => {
    test("exposes only dependencies in managed project schema", (): void => {
        const tool = createAutocodeScriptProjectTool() as unknown as { args: Record<string, unknown> }

        expect(Object.keys(tool.args)).toEqual(["dependencies"])
    })

    test("returns standard validation failure without creating project", async () => {
        const factory = mock((_dependencies: ManagedScriptProjectDependencies) => { throw new Error("must not create") })
        const response = parse(await createAutocodeScriptProjectTool(undefined, {}, factory).execute({ dependencies: [] } as never, createToolContext()))

        expect(response).toMatchObject({ ok: false, status: "blocked", failedAction: "setup managed scripts project", blocker: { code: "validation_error" } })
        expect(typeof response.error).toBe("string")
        expect(typeof response.instruction).toBe("string")
        expect(factory).not.toHaveBeenCalled()
    })

    test("omits script_file and forwards optional dependencies to setup", async (): Promise<void> => {
        const { factory, project } = createFactory(successfulResult())
        const tool = createAutocodeScriptProjectTool(undefined, {}, factory) as unknown as { args: Record<string, unknown>, execute: (args: never, context: ReturnType<typeof createToolContext>) => Promise<string | { output: string }> }
        const context = createToolContext({ agent: "execute-script", directory })
        const response = parse(await tool.execute({ dependencies: { lodash: "^4.17.0" }, script_file: "/caller/controlled-source.mjs" } as never, context))
        await tool.execute({} as never, context)
        await tool.execute({ dependencies: {} } as never, context)

        expect(response).toMatchObject({
            ok: true,
            status: "ready",
            ...publicPaths,
            dependency_provenance: [],
            npm: {
                command: ["npm", "install"],
                exit_code: 0,
                stdout: "installed",
                stderr: "",
                log_path: npmLogPath,
            },
        })
        expectPublicPathKeys(response)
        expect(tool.args).not.toHaveProperty("script_file")
        expect(paths.scriptsRoot).toBe(join(directory, ".opencode", "autocode", "scripts"))
        expect(basename(paths.sourceRoot)).toMatch(/^\d{2}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_job_1$/)
        expect(paths.logsRoot).toBe(join(paths.scriptsRoot, ".meta", "logs"))
        expect(paths.servicesRoot).toBe(join(paths.scriptsRoot, ".meta", "services"))
        expect(project.setup).toHaveBeenNthCalledWith(1, { dependencies: { lodash: "^4.17.0" } })
        expect(project.setup).toHaveBeenNthCalledWith(2, {})
        expect(project.setup).toHaveBeenNthCalledWith(3, { dependencies: {} })
        expect(project.install).not.toHaveBeenCalled()
        expect(project.verify).not.toHaveBeenCalled()
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({ context }))
    })

    test("maps core blockers and failures to retry JSON", async () => {
        const blocked = createFactory({ ok: false, paths, dependencies: [], npm: successfulResult().npm, blocker: { code: "job_workspace_required", message: "Select one job." } })
        const failed = createFactory({ ok: false, paths, dependencies: [], npm: successfulResult().npm, error: { code: "filesystem_error", message: "disk denied" } })
        const blockedResponse = parse(await createAutocodeScriptProjectTool(undefined, {}, blocked.factory).execute({}, createToolContext({ directory })))
        const failedResponse = parse(await createAutocodeScriptProjectTool(undefined, {}, failed.factory).execute({}, createToolContext({ directory })))

        expect(blockedResponse).toMatchObject({
            ok: false,
            status: "blocked",
            failedAction: "setup managed scripts project",
            error: "Select one job.",
            instruction: "Set current session title to include letters or numbers, then retry setup.",
            blocker: { code: "job_workspace_required", message: "Select one job." },
            ...publicPaths,
            dependency_provenance: [],
            npm: {
                command: ["npm", "install"],
                exit_code: 0,
                stdout: "installed",
                stderr: "",
                log_path: npmLogPath,
            },
        })
        expect(failedResponse).toMatchObject({
            ok: false,
            status: "failed",
            failedAction: "setup managed scripts project",
            error: "disk denied",
            instruction: "Review npm output and managed-project paths, correct the failure, then retry setup.",
            failure: { code: "filesystem_error", message: "disk denied" },
            ...publicPaths,
            dependency_provenance: [],
            npm: {
                command: ["npm", "install"],
                exit_code: 0,
                stdout: "installed",
                stderr: "",
                log_path: npmLogPath,
            },
        })
        expectPublicPathKeys(blockedResponse)
        expectPublicPathKeys(failedResponse)
    })

    test("aborts JSON response when factory or setup throws", async () => {
        const factoryThrowing = mock((_dependencies: ManagedScriptProjectDependencies) => { throw new Error("factory denied") })
        const setupThrowing: ManagedScriptProject = {
            setup: mock(async (): Promise<ManagedScriptProjectResult> => { throw new Error("setup denied") }),
            install: mock(async (): Promise<ManagedScriptProjectResult> => successfulResult()),
            verify: mock(async (): Promise<ManagedScriptProjectVerifyResult> => ({ ok: true })),
        }
        const setupFactory = mock((_dependencies: ManagedScriptProjectDependencies) => setupThrowing)
        const factoryResponse = parse(await createAutocodeScriptProjectTool(undefined, {}, factoryThrowing).execute({}, createToolContext()))
        const setupResponse = parse(await createAutocodeScriptProjectTool(undefined, {}, setupFactory).execute({}, createToolContext()))

        expect(factoryResponse).toMatchObject({ ok: false, status: "failed", failedAction: "setup managed scripts project" })
        expect(setupResponse).toMatchObject({ ok: false, status: "failed", failedAction: "setup managed scripts project" })
        expect(String(factoryResponse.error)).toContain("factory denied")
        expect(String(setupResponse.error)).toContain("setup denied")
    })
})
