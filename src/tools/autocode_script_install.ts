import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createManagedScriptProject, type ManagedScriptProject, type ManagedScriptProjectDependencies, type ManagedScriptProjectFailure, type ManagedScriptProjectNpmResult, type ManagedScriptProjectResult } from "@/utils/managed_script_project"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

export type AutocodeScriptInstallToolDependencies = Omit<ManagedScriptProjectDependencies, "client" | "context">

export type ManagedScriptProjectFactory = (dependencies: ManagedScriptProjectDependencies) => ManagedScriptProject

type ScriptInstallToolInput = {
    dependencies?: Record<string, string>
    upgrade?: boolean
}

type ScriptInstallToolIssue = {
    code: string
    message: string
}

type StandardFailureResponse = {
    failedAction: string
    error: string
    instruction: string
}

const installAction = "install managed scripts dependencies"

function readFailureResponse(response: string): StandardFailureResponse {
    return JSON.parse(response) as StandardFailureResponse
}

function createNpmDetails(npm: ManagedScriptProjectNpmResult | undefined): Record<string, unknown> {
    if (!npm) return {}
    return {
        npm: {
            command: ["npm", ...npm.command],
            exit_code: npm.exitCode,
            stdout: npm.stdout,
            stderr: npm.stderr,
            log_path: npm.logPath,
        },
    }
}

function createProjectDetails(result: ManagedScriptProjectResult): Record<string, unknown> {
    return {
        ...(result.paths
            ? {
                workspace_path: result.paths.directory,
                project_path: result.paths.scriptsRoot,
                source_path: result.paths.sourceRoot,
                manifest_path: result.paths.manifestPath,
                lock_path: result.paths.lockfilePath,
                node_modules_path: result.paths.nodeModulesPath,
                logs_path: result.paths.logsRoot,
                ...(result.npm ? { npm_log_path: result.npm.logPath } : {}),
            }
            : {}),
        ...(result.dependencies ? { dependency_provenance: result.dependencies } : {}),
        ...createNpmDetails(result.npm),
    }
}

function createRetryFailureResponse(issue: ScriptInstallToolIssue, instruction: string, result?: ManagedScriptProjectResult): string {
    return JSON.stringify({
        ok: false,
        status: "blocked",
        ...readFailureResponse(createRetryResponse(installAction, issue.message, instruction)),
        blocker: issue,
        ...(result ? createProjectDetails(result) : {}),
    })
}

function createErrorFailureResponse(issue: ManagedScriptProjectFailure, result: ManagedScriptProjectResult): string {
    return JSON.stringify({
        ok: false,
        status: "failed",
        ...readFailureResponse(createRetryResponse(installAction, issue.message, "Review npm output and managed-project paths, correct the failure, then retry install.")),
        failure: issue,
        ...createProjectDetails(result),
    })
}

function createUnexpectedFailureResponse(error: unknown): string {
    return JSON.stringify({
        ok: false,
        status: "failed",
        ...readFailureResponse(createAbortResponse(installAction, error)),
    })
}

function createSuccessResponse(result: Extract<ManagedScriptProjectResult, { ok: true }>): string {
    return JSON.stringify({
        ok: true,
        status: "installed",
        ...createProjectDetails(result),
        instruction: "Managed script dependencies are installed. This tool does not run scripts or services.",
    })
}

function createInstallResponse(result: ManagedScriptProjectResult): string {
    if (result.ok) return createSuccessResponse(result)
    if (result.blocker) {
        const instruction = result.blocker.code === "job_workspace_required"
            ? "Set current session title to produce a valid job name, then retry install."
            : result.blocker.code === "runtime_unavailable"
                ? "Install Node.js 20+ and npm in current runtime, then retry install."
                : "Correct managed-script install input or project state, then retry install."
        return createRetryFailureResponse(result.blocker, instruction, result)
    }
    if (result.error) return createErrorFailureResponse(result.error, result)
    return createUnexpectedFailureResponse("Managed script install returned no success result, blocker, or error.")
}

function validateInput(args: ScriptInstallToolInput): ScriptInstallToolIssue | undefined {
    if (args.dependencies !== undefined && (typeof args.dependencies !== "object" || args.dependencies === null || Array.isArray(args.dependencies) || Object.values(args.dependencies).some((range: string): boolean => typeof range !== "string"))) {
        return { code: "validation_error", message: "dependencies must be a record of npm package names to version ranges." }
    }
    if (args.upgrade !== undefined && typeof args.upgrade !== "boolean") {
        return { code: "validation_error", message: "upgrade must be a boolean." }
    }
    return undefined
}

export function createAutocodeScriptInstallTool(
    client?: OpencodeClient,
    dependencies: AutocodeScriptInstallToolDependencies = {},
    projectFactory: ManagedScriptProjectFactory = createManagedScriptProject,
): ReturnType<typeof tool> {
    return tool({
        description: "Add or repair managed-script dependencies. Healthy declared environment is a no-op.",
        args: {
            dependencies: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("Optional npm registry package names mapped to version ranges or tags; no URL, Git, or archive sources. Omit for declared-environment repair."),
            upgrade: tool.schema.boolean().optional().default(false).describe("Incompatible requested dependencies require explicit upgrade:true; default false. Requested dependencies only; never blanket latest or upgrade-all updates."),
        },
        async execute(args, context): Promise<string> {
            const validationError = validateInput(args)
            if (validationError) {
                return createRetryFailureResponse(validationError, "Provide dependencies as npm package-to-range strings and upgrade as a boolean.")
            }

            try {
                const project = projectFactory({ ...dependencies, ...(client ? { client } : {}), context })
                return createInstallResponse(await project.install({
                    ...(args.dependencies ? { dependencies: args.dependencies } : {}),
                    upgrade: args.upgrade ?? false,
                }))
            }
            catch (error) {
                return createUnexpectedFailureResponse(error)
            }
        },
    })
}
