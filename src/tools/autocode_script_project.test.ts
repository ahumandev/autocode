import { describe, expect, mock, test } from "bun:test"
import type { ManagedScriptProject, ManagedScriptProjectDependencies, ManagedScriptProjectResult } from "@/utils/managed_script_project"
import { createAutocodeScriptProjectTool, type ManagedScriptProjectFactory } from "./autocode_script_project"
import { createToolContext } from "./test_context"

const paths = {
    workspacePath: "/jobs/job-1",
    projectPath: "/jobs/job-1/scripts",
    sourcePath: "/jobs/job-1/scripts/src",
    logsPath: "/jobs/job-1/scripts/logs",
    npmLogPath: "/jobs/job-1/scripts/logs/npm.log",
    manifestPath: "/jobs/job-1/scripts/package.json",
    lockPath: "/jobs/job-1/scripts/package-lock.json",
    nodeModulesPath: "/jobs/job-1/scripts/node_modules",
    servicesPath: "/jobs/job-1/scripts/services",
    agentsPath: "/jobs/job-1/scripts/AGENTS.md",
}

const publicPaths = {
    workspace_path: paths.workspacePath,
    project_path: paths.projectPath,
    source_path: paths.sourcePath,
    logs_path: paths.logsPath,
    services_path: paths.servicesPath,
}

const managedPaths = {
    workspacePath: paths.workspacePath,
    scriptsRoot: paths.projectPath,
    sourceRoot: paths.sourcePath,
    manifestPath: paths.manifestPath,
    lockPath: paths.lockPath,
    nodeModulesPath: paths.nodeModulesPath,
    logsPath: paths.logsPath,
    servicesPath: paths.servicesPath,
    agentsPath: paths.agentsPath,
}

function parse(result: string | { output: string }): Record<string, unknown> {
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function expectPublicPathKeys(response: Record<string, unknown>): void {
    expect(Object.keys(response).filter((key: string): boolean => key.endsWith("_path")).sort()).toEqual(Object.keys(publicPaths).sort())
}

function successfulResult(): Extract<ManagedScriptProjectResult, { ok: true }> {
    return { ok: true, paths: managedPaths, dependencies: [], npm: { exitCode: 0, stdout: "installed", stderr: "", command: ["install"], logPath: paths.npmLogPath } }
}

function createFactory(result: ManagedScriptProjectResult): { factory: ManagedScriptProjectFactory, project: ManagedScriptProject } {
    const project: ManagedScriptProject = {
        setup: mock(async () => result),
        install: mock(async () => result),
        reconcile: mock(async () => result),
    }
    return { factory: mock((_dependencies: ManagedScriptProjectDependencies) => project), project }
}

describe("autocode_script_project tool", () => {
    test("omits timeout from managed project schema", () => {
        const tool = createAutocodeScriptProjectTool() as unknown as { args: Record<string, unknown> }

        expect(tool.args).not.toHaveProperty("timeout")
    })

    test("returns standard validation failure without creating project", async () => {
        const factory = mock((_dependencies: ManagedScriptProjectDependencies) => { throw new Error("must not create") })
        const response = parse(await createAutocodeScriptProjectTool(undefined, {}, factory).execute({ dependencies: [] } as never, createToolContext()))

        expect(response).toMatchObject({ ok: false, status: "blocked", failedAction: "setup managed scripts project", blocker: { code: "validation_error" } })
        expect(typeof response.error).toBe("string")
        expect(typeof response.instruction).toBe("string")
        expect(factory).not.toHaveBeenCalled()
    })

    test("omits script_file and forwards only dependencies to setup", async () => {
        const { factory, project } = createFactory(successfulResult())
        const tool = createAutocodeScriptProjectTool(undefined, {}, factory) as unknown as { args: Record<string, unknown>, execute: (args: never, context: ReturnType<typeof createToolContext>) => Promise<string | { output: string }> }
        const response = parse(await tool.execute({ dependencies: { lodash: "^4.17.0" }, script_file: "/caller/controlled-source.mjs" } as never, createToolContext({ agent: "execute_script" })))

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
                log_path: paths.npmLogPath,
            },
        })
        expectPublicPathKeys(response)
        expect(tool.args).not.toHaveProperty("script_file")
        expect(project.setup).toHaveBeenCalledWith({ dependencies: { lodash: "^4.17.0" } })
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ agent: "execute_script" }) }))
    })

    test("maps core blockers and failures to retry JSON", async () => {
        const blocked = createFactory({ ok: false, paths: managedPaths, dependencies: [], npm: successfulResult().npm, blocker: { code: "job_workspace_required", message: "Select one job." } })
        const failed = createFactory({ ok: false, paths: managedPaths, dependencies: [], npm: successfulResult().npm, error: { code: "filesystem_error", message: "disk denied" } })
        const blockedResponse = parse(await createAutocodeScriptProjectTool(undefined, {}, blocked.factory).execute({}, createToolContext()))
        const failedResponse = parse(await createAutocodeScriptProjectTool(undefined, {}, failed.factory).execute({}, createToolContext()))

        expect(blockedResponse).toMatchObject({
            ok: false,
            status: "blocked",
            failedAction: "setup managed scripts project",
            error: "Select one job.",
            instruction: "Start or select a timestamped job workspace for the current session, then retry setup.",
            blocker: { code: "job_workspace_required", message: "Select one job." },
            ...publicPaths,
            dependency_provenance: [],
            npm: {
                command: ["npm", "install"],
                exit_code: 0,
                stdout: "installed",
                stderr: "",
                log_path: paths.npmLogPath,
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
                log_path: paths.npmLogPath,
            },
        })
        expectPublicPathKeys(blockedResponse)
        expectPublicPathKeys(failedResponse)
    })

    test("aborts JSON response when factory or setup throws", async () => {
        const factoryThrowing = mock((_dependencies: ManagedScriptProjectDependencies) => { throw new Error("factory denied") })
        const setupThrowing: ManagedScriptProject = {
            setup: mock(async () => { throw new Error("setup denied") }),
            install: mock(async () => successfulResult()),
            reconcile: mock(async () => successfulResult()),
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
