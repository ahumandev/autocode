import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { isAbsolute, win32 } from "node:path"
import type { ManagedScriptLifecycle } from "@/hooks/managed_script_lifecycle"
import { createManagedScriptRuntime, type ManagedScriptRuntime, type ManagedScriptRuntimeDependencies } from "@/utils/managed_script_runtime"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

export type AutocodeScriptServiceToolDependencies = Omit<ManagedScriptRuntimeDependencies, "client" | "context">

export type ManagedScriptServiceRuntimeFactory = (dependencies: ManagedScriptRuntimeDependencies) => ManagedScriptRuntime

type ScriptServiceAction = "start" | "status" | "stop"

type ScriptServiceToolInput = {
    action: ScriptServiceAction
    entry?: string
    argv?: string[]
    run_id?: string
}

type ScriptServiceToolIssue = {
    code: string
    message: string
}

type StandardFailureResponse = {
    failedAction: string
    error: string
    instruction: string
}

const serviceAction = "manage managed script service"
const serviceActions = ["start", "status", "stop"] as const

function readFailureResponse(response: string): StandardFailureResponse {
    return JSON.parse(response) as StandardFailureResponse
}

function createRetryFailureResponse(issue: ScriptServiceToolIssue): string {
    return JSON.stringify({
        ok: false,
        status: "blocked",
        ...readFailureResponse(createRetryResponse(serviceAction, issue.message, "Provide source-relative .mjs entry, such as task.mjs or nested/task.mjs, and string argv values when starting; otherwise provide run_id.")),
        blocker: issue,
    })
}

function createUnexpectedFailureResponse(error: unknown): string {
    return JSON.stringify({
        ok: false,
        status: "failed",
        ...readFailureResponse(createAbortResponse(serviceAction, error)),
    })
}

function validateStartInput(args: ScriptServiceToolInput): ScriptServiceToolIssue | undefined {
    if (typeof args.entry !== "string" || !args.entry) {
        return { code: "validation_error", message: "entry is required and must be a non-empty source-relative .mjs filename when action is start." }
    }
    const entrySegments = args.entry.split("/")
    if (isAbsolute(args.entry) || win32.isAbsolute(args.entry) || args.entry.includes("\\") || entrySegments.includes("..") || entrySegments[0] === "src" || !args.entry.endsWith(".mjs")) {
        return { code: "validation_error", message: "entry must be a source-relative .mjs filename, such as task.mjs or nested/task.mjs, without src/ prefix, absolute paths, backslashes, or traversal." }
    }
    if (args.run_id !== undefined) {
        return { code: "validation_error", message: "run_id is not valid when action is start." }
    }
    if (args.argv !== undefined && (!Array.isArray(args.argv) || !args.argv.every((argument: unknown): boolean => typeof argument === "string"))) {
        return { code: "validation_error", message: "argv is only valid for action start and must contain only strings." }
    }
    return undefined
}

function validateRunIdInput(args: ScriptServiceToolInput): ScriptServiceToolIssue | undefined {
    if (args.entry !== undefined) {
        return { code: "validation_error", message: `entry is not valid when action is ${args.action}.` }
    }
    if (args.argv !== undefined) {
        return { code: "validation_error", message: `argv is not valid when action is ${args.action}.` }
    }
    if (typeof args.run_id !== "string" || !args.run_id) {
        return { code: "validation_error", message: `run_id is required and must be a non-empty string when action is ${args.action}.` }
    }
    return undefined
}

function validateInput(args: ScriptServiceToolInput): ScriptServiceToolIssue | undefined {
    if (!serviceActions.includes(args.action)) {
        return { code: "validation_error", message: "action must be start, status, or stop." }
    }
    if (args.action === "start") return validateStartInput(args)
    return validateRunIdInput(args)
}

async function executeServiceAction(runtime: ManagedScriptRuntime, args: ScriptServiceToolInput): Promise<string> {
    if ((args.action === "status" || args.action === "stop") && typeof args.run_id === "string") {
        return JSON.stringify(args.action === "status"
            ? await runtime.status({ run_id: args.run_id })
            : await runtime.stop({ run_id: args.run_id }))
    }
    return createRetryFailureResponse({ code: "validation_error", message: "Invalid action-specific fields." })
}

export function createAutocodeScriptServiceTool(
    client?: OpencodeClient,
    dependencies: AutocodeScriptServiceToolDependencies = {},
    runtimeFactory: ManagedScriptServiceRuntimeFactory = createManagedScriptRuntime,
    lifecycle?: ManagedScriptLifecycle,
): ReturnType<typeof tool> {
    return tool({
        description: "Start source-relative .mjs scripted services, or inspect or stop managed services.",
        args: {
            action: tool.schema.enum(serviceActions).describe("Required service action: start, status, or stop."),
            entry: tool.schema.string().optional().describe("Required source-relative .mjs entry filename only when action is start, such as task.mjs or nested/task.mjs; omit src/ prefix."),
            argv: tool.schema.array(tool.schema.string()).optional().describe("Optional string arguments only when action is start."),
            run_id: tool.schema.string().optional().describe("Required opaque job-owned run ID only when action is status or stop."),
        },
        async execute(args, context): Promise<string> {
            const validationError = validateInput(args)
            if (validationError) return createRetryFailureResponse(validationError)

            try {
                const runtime = runtimeFactory({ ...dependencies, ...(client ? { client } : {}), context })
                if (args.action === "start" && typeof args.entry === "string") {
                    const startResult = await runtime.start({
                        entry: args.entry,
                        ...(args.argv !== undefined ? { argv: args.argv } : {}),
                    })
                    lifecycle?.registerStart(context, startResult, context.abort)
                    return JSON.stringify(startResult)
                }
                return await executeServiceAction(runtime, args)
            }
            catch (error) {
                return createUnexpectedFailureResponse(error)
            }
        },
    })
}
