import { describe, expect, mock, test } from "bun:test"
import type { ManagedScriptProject, ManagedScriptProjectDependencies, ManagedScriptProjectResult } from "@/utils/managed_script_project"
import { createAutocodeScriptInstallTool, type ManagedScriptProjectFactory } from "./autocode_script_install"
import { createToolContext } from "./test_context"

const paths = {
    workspacePath: "/jobs/job-1",
    scriptsRoot: "/jobs/job-1/scripts",
    sourceRoot: "/jobs/job-1/scripts/src",
    manifestPath: "/jobs/job-1/scripts/package.json",
    lockPath: "/jobs/job-1/scripts/package-lock.json",
    nodeModulesPath: "/jobs/job-1/scripts/node_modules",
    logsPath: "/jobs/job-1/scripts/logs",
    servicesPath: "/jobs/job-1/scripts/services",
    agentsPath: "/jobs/job-1/scripts/AGENTS.md",
}

function parse(result: string | { output: string }): Record<string, unknown> {
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function successfulResult(): Extract<ManagedScriptProjectResult, { ok: true }> {
    return { ok: true, paths, dependencies: [], npm: { exitCode: 0, stdout: "installed", stderr: "", command: ["install"], logPath: "/jobs/job-1/scripts/logs/npm.log" } }
}

function createFactory(result: ManagedScriptProjectResult): { factory: ManagedScriptProjectFactory, project: ManagedScriptProject } {
    const project: ManagedScriptProject = {
        setup: mock(async () => result),
        install: mock(async () => result),
        reconcile: mock(async () => result),
    }
    return { factory: mock((_dependencies: ManagedScriptProjectDependencies) => project), project }
}

describe("autocode_script_install tool", () => {
    test("omits timeout from managed install schema", () => {
        const tool = createAutocodeScriptInstallTool() as unknown as { args: Record<string, unknown> }

        expect(tool.args).not.toHaveProperty("timeout")
    })

    test("returns standard validation failure without creating project", async () => {
        const factory = mock((_dependencies: ManagedScriptProjectDependencies) => { throw new Error("must not create") })
        const response = parse(await createAutocodeScriptInstallTool(undefined, {}, factory).execute({ dependencies: [] } as never, createToolContext()))

        expect(response).toMatchObject({ ok: false, status: "blocked", failedAction: "install managed scripts dependencies", blocker: { code: "validation_error" } })
        expect(typeof response.error).toBe("string")
        expect(typeof response.instruction).toBe("string")
        expect(factory).not.toHaveBeenCalled()
    })

    test("omits script_file and forwards only dependencies to install", async () => {
        const { factory, project } = createFactory(successfulResult())
        const tool = createAutocodeScriptInstallTool(undefined, {}, factory) as unknown as { args: Record<string, unknown>, execute: (args: never, context: ReturnType<typeof createToolContext>) => Promise<string | { output: string }> }
        const response = parse(await tool.execute({ dependencies: { zod: "^3.0.0" }, script_file: "/caller/controlled-source.mjs" } as never, createToolContext()))

        expect(response).toMatchObject({ ok: true, status: "installed", workspace_path: paths.workspacePath, project_path: paths.scriptsRoot, source_path: paths.sourceRoot, manifest_path: paths.manifestPath, lock_path: paths.lockPath, node_modules_path: paths.nodeModulesPath, logs_path: paths.logsPath })
        expect(tool.args).not.toHaveProperty("script_file")
        expect(project.install).toHaveBeenCalledWith({ dependencies: { zod: "^3.0.0" } })
    })

    test("maps core blockers and failures to install JSON", async () => {
        const blocked = createFactory({ ok: false, paths, blocker: { code: "runtime_unavailable", message: "Need Node." } })
        const failed = createFactory({ ok: false, paths, error: { code: "dependency_unsatisfied", message: "wrong version" } })
        const blockedResponse = parse(await createAutocodeScriptInstallTool(undefined, {}, blocked.factory).execute({}, createToolContext()))
        const failedResponse = parse(await createAutocodeScriptInstallTool(undefined, {}, failed.factory).execute({}, createToolContext()))

        expect(blockedResponse).toMatchObject({ ok: false, status: "blocked", blocker: { code: "runtime_unavailable" }, lock_path: paths.lockPath })
        expect(failedResponse).toMatchObject({ ok: false, status: "failed", failure: { code: "dependency_unsatisfied" }, node_modules_path: paths.nodeModulesPath })
        expect(typeof blockedResponse.instruction).toBe("string")
        expect(typeof failedResponse.error).toBe("string")
    })

    test("aborts JSON response when factory or install throws", async () => {
        const factoryThrowing = mock((_dependencies: ManagedScriptProjectDependencies) => { throw new Error("factory denied") })
        const installThrowing: ManagedScriptProject = {
            setup: mock(async () => successfulResult()),
            install: mock(async () => { throw new Error("install denied") }),
            reconcile: mock(async () => successfulResult()),
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
