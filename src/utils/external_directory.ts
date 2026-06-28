import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import type { ExternalDirectoryRules, PermissionAction } from "@/config"
import { loadAutocodeConfig } from "@/config"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { authorizeToolAsk } from "./tool_permission"

const REGEX_ESCAPE_PATTERN = /[.+^${}()|[\]\\]/g

function patternToRegExp(pattern: string): RegExp {
    let source = "^"
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i]
        if (ch === "*") source += ".*"
        else source += ch.replace(REGEX_ESCAPE_PATTERN, "\\$&")
    }
    return new RegExp(`${source}$`)
}

function patternMatches(pattern: string, absolutePath: string): boolean {
    if (pattern === absolutePath) return true
    if (absolutePath.startsWith(`${pattern}/`)) return true
    return patternToRegExp(pattern).test(absolutePath)
}

export function matchExternalDirectoryAction(rules: ExternalDirectoryRules, absolutePath: string): PermissionAction | undefined {
    let longestLength = -1
    let matched: PermissionAction | undefined
    for (const [pattern, action] of Object.entries(rules)) {
        if (!patternMatches(pattern, absolutePath)) continue
        if (pattern.length <= longestLength) continue
        longestLength = pattern.length
        matched = action
    }
    return matched
}

export async function authorizeExternalContentPath(
    context: ToolContext,
    absolutePath: string,
    failedAction: string,
): Promise<{ ok: true } | { ok: false, response: string }> {
    const { externalDirectories } = await loadAutocodeConfig(context.worktree, context.directory)
    const action = matchExternalDirectoryAction(externalDirectories, absolutePath)

    if (action === "allow") return { ok: true }

    if (action === "ask") {
        if (typeof context.ask !== "function") {
            return { ok: false, response: createAbortResponse(failedAction, "Tool context ask() is unavailable") }
        }
        const targetDirectory = path.dirname(absolutePath)
        const patterns = [targetDirectory, `${targetDirectory}/*`]
        const request = {
            permission: "external_directory",
            patterns,
            always: patterns,
            metadata: {
                tool: "autocode_content",
                target_directory: targetDirectory,
                requested_target_directory: absolutePath,
            },
        }
        try {
            const auth = context.ask(request)
            await authorizeToolAsk(auth)
            return { ok: true }
        }
        catch (error) {
            return { ok: false, response: createAbortResponse(failedAction, error) }
        }
    }

    return {
        ok: false,
        response: createRetryResponse(
            failedAction,
            `Path '${absolutePath}' is outside the working directory and is not allowed by external_directory configuration.`,
            "Add an allow/ask rule for this path in autocode.jsonc permission.external_directory, or use a path inside the working directory.",
        ),
    }
}
