import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createManagedScriptProject, type ManagedScriptProject, type ManagedScriptProjectDependencies, type ManagedScriptProjectFailure, type ManagedScriptProjectNpmResult, type ManagedScriptProjectResult } from "@/utils/managed_script_project"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

export type AutocodeScriptProjectToolDependencies = Omit<ManagedScriptProjectDependencies, "client" | "context">

export type ManagedScriptProjectFactory = (dependencies: ManagedScriptProjectDependencies) => ManagedScriptProject

type ScriptProjectToolInput = {
    dependencies?: Record<string, string>
}

type ScriptProjectToolIssue = {
    code: string
    message: string
}

type StandardFailureResponse = {
    failedAction: string
    error: string
    instruction: string
}

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
                workspace_path: result.paths.workspacePath,
                project_path: result.paths.scriptsRoot,
                source_path: result.paths.sourceRoot,
                logs_path: result.paths.logsPath,
                services_path: result.paths.servicesPath,
            }
            : {}),
        ...(result.dependencies ? { dependency_provenance: result.dependencies } : {}),
        ...createNpmDetails(result.npm),
    }
}

function createRetryFailureResponse(issue: ScriptProjectToolIssue, instruction: string, result?: ManagedScriptProjectResult): string {
    return JSON.stringify({
        ok: false,
        status: "blocked",
        ...readFailureResponse(createRetryResponse("setup managed scripts project", issue.message, instruction)),
        blocker: issue,
        ...(result ? createProjectDetails(result) : {}),
    })
}

function createErrorFailureResponse(issue: ManagedScriptProjectFailure, result: ManagedScriptProjectResult): string {
    return JSON.stringify({
        ok: false,
        status: "failed",
        ...readFailureResponse(createRetryResponse("setup managed scripts project", issue.message, "Review npm output and managed-project paths, correct the failure, then retry setup.")),
        failure: issue,
        ...createProjectDetails(result),
    })
}

function createUnexpectedFailureResponse(error: unknown): string {
    return JSON.stringify({
        ok: false,
        status: "failed",
        ...readFailureResponse(createAbortResponse("setup managed scripts project", error)),
    })
}

function createSuccessResponse(result: Extract<ManagedScriptProjectResult, { ok: true }>): string {
    return JSON.stringify({
        ok: true,
        status: "ready",
        ...createProjectDetails(result),
        instruction: "Managed scripts project is ready. Write scripts in src/; this tool does not run scripts or services.",
    })
}

function createSetupResponse(result: ManagedScriptProjectResult): string {
    if (result.ok) return createSuccessResponse(result)
    if (result.blocker) {
        const instruction = result.blocker.code === "job_workspace_required"
            ? "Start or select a timestamped job workspace for the current session, then retry setup."
            : result.blocker.code === "runtime_unavailable"
                ? "Install Node.js 20+ and npm in the current runtime, then retry setup."
                : "Correct the managed-script setup input or project state, then retry setup."
        return createRetryFailureResponse(result.blocker, instruction, result)
    }
    if (result.error) return createErrorFailureResponse(result.error, result)
    return createUnexpectedFailureResponse("Managed script setup returned no success result, blocker, or error.")
}

function validateInput(args: ScriptProjectToolInput): ScriptProjectToolIssue | undefined {
    if (args.dependencies !== undefined && (typeof args.dependencies !== "object" || args.dependencies === null || Array.isArray(args.dependencies) || Object.values(args.dependencies).some((range: string): boolean => typeof range !== "string"))) {
        return { code: "validation_error", message: "dependencies must be a record of npm package names to version ranges." }
    }
    return undefined
}

export function createAutocodeScriptProjectTool(
    client?: OpencodeClient,
    dependencies: AutocodeScriptProjectToolDependencies = {},
    projectFactory: ManagedScriptProjectFactory = createManagedScriptProject,
): ReturnType<typeof tool> {
    return tool({
        description: "ALWAYS call autocode_script_project BEFORE creating temporary session scripts. This tool sets up sub-project to contain scripts.",
        args: {
            dependencies: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe("Optional npm dependency package names and version ranges."),
        },
        async execute(args, context): Promise<string> {
            const validationError = validateInput(args)
            if (validationError) {
                return createRetryFailureResponse(validationError, "Provide dependencies as npm package-to-range strings.")
            }

            try {
                const project = projectFactory({ ...dependencies, ...(client ? { client } : {}), context })
                return createSetupResponse(await project.setup({
                    ...(args.dependencies ? { dependencies: args.dependencies } : {}),
                }))
            }
            catch (error) {
                return createUnexpectedFailureResponse(error)
            }
        },
    })
}
