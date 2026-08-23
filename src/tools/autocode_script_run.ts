import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { isAbsolute, win32 } from "node:path"
import { createManagedScriptRuntime, type ManagedScriptRunResult, type ManagedScriptRuntime, type ManagedScriptRuntimeDependencies } from "@/utils/managed_script_runtime"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

export type AutocodeScriptRunToolDependencies = Omit<ManagedScriptRuntimeDependencies, "client" | "context">

export type ManagedScriptRuntimeFactory = (dependencies: ManagedScriptRuntimeDependencies) => ManagedScriptRuntime

type ScriptRunToolInput = {
    entry: string
    argv?: string[]
    timeout_ms?: number
}

type ScriptRunToolIssue = {
    code: string
    message: string
}

type StandardFailureResponse = {
    failedAction: string
    error: string
    instruction: string
}

const runAction = "run managed script"

function readFailureResponse(response: string): StandardFailureResponse {
    return JSON.parse(response) as StandardFailureResponse
}

function createRetryFailureResponse(issue: ScriptRunToolIssue, instruction: string): string {
    return JSON.stringify({
        ok: false,
        status: "blocked",
        ...readFailureResponse(createRetryResponse(runAction, issue.message, instruction)),
        blocker: issue,
    })
}

function createUnexpectedFailureResponse(error: unknown): string {
    return JSON.stringify({
        ok: false,
        status: "failed",
        ...readFailureResponse(createAbortResponse(runAction, error)),
    })
}

function validateInput(args: ScriptRunToolInput): ScriptRunToolIssue | undefined {
    const entrySegments = typeof args.entry === "string" ? args.entry.split("/") : []
    if (typeof args.entry !== "string" || !args.entry || isAbsolute(args.entry) || win32.isAbsolute(args.entry) || args.entry.includes("\\") || entrySegments.includes("..") || entrySegments[0] === "src" || !args.entry.endsWith(".mjs")) {
        return { code: "validation_error", message: "entry must be a source-relative .mjs filename, such as task.mjs or nested/task.mjs, without src/ prefix, absolute paths, backslashes, or traversal." }
    }
    if (args.argv !== undefined && (!Array.isArray(args.argv) || !args.argv.every((argument: unknown): boolean => typeof argument === "string"))) {
        return { code: "validation_error", message: "argv must contain only strings." }
    }
    if (args.timeout_ms !== undefined && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1 || args.timeout_ms > 1_800_000)) {
        return { code: "validation_error", message: "timeout_ms must be an integer between 1 and 1800000 milliseconds." }
    }
    return undefined
}

function createSuccessResponse(result: ManagedScriptRunResult): string {
    return JSON.stringify(result)
}

export function createAutocodeScriptRunTool(
    client?: OpencodeClient,
    dependencies: AutocodeScriptRunToolDependencies = {},
    runtimeFactory: ManagedScriptRuntimeFactory = createManagedScriptRuntime,
): ReturnType<typeof tool> {
    return tool({
        description: "Run managed source-relative .mjs script by direct Node execution with cwd set to session scripts sub-project. Inline stdout and stderr are bounded; log_path contains full output.",
        args: {
            entry: tool.schema.string().describe("Required source-relative .mjs entry filename, such as task.mjs or nested/task.mjs; omit src/ prefix."),
            argv: tool.schema.array(tool.schema.string()).optional().describe("Optional string arguments passed to entry."),
            timeout_ms: tool.schema.number().int().min(1).max(1_800_000).optional().describe("Optional execution timeout in milliseconds; runtime default is 300000."),
        },
        async execute(args, context): Promise<string> {
            const validationError = validateInput(args)
            if (validationError) {
                return createRetryFailureResponse(validationError, "Provide source-relative .mjs entry, such as task.mjs or nested/task.mjs, string argv values, and timeout_ms from 1 to 1800000 milliseconds.")
            }

            try {
                const runtime = runtimeFactory({ ...dependencies, ...(client ? { client } : {}), context })
                return createSuccessResponse(await runtime.run({
                    entry: args.entry,
                    ...(args.argv !== undefined ? { argv: args.argv } : {}),
                    ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
                }))
            }
            catch (error) {
                return createUnexpectedFailureResponse(error)
            }
        },
    })
}
