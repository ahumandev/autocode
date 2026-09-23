import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import type { ExternalDirectoryRules, PermissionAction } from "@/config"
import { loadAutocodeConfig } from "@/config"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import type { PermissionRule } from "./permissions"
import { matchesPermissionPattern } from "./permissions"
import { authorizeToolAsk } from "./tool_permission"

function hasWindowsPathSemantics(absolutePath: string): boolean {
    return /^[a-z]:[\\/]/i.test(absolutePath) || /^(?:\\\\|\/\/)/.test(absolutePath)
}

function normalizeWindowsPath(path: string): string {
    return path.replaceAll("\\", "/").toLowerCase()
}

function patternMatches(pattern: string, absolutePath: string): boolean {
    const isWindowsPath = hasWindowsPathSemantics(absolutePath)
    const matchPattern = isWindowsPath ? normalizeWindowsPath(pattern) : pattern
    const matchPath = isWindowsPath ? normalizeWindowsPath(absolutePath) : absolutePath

    return matchesPermissionPattern(matchPattern, matchPath)
}

export function matchExternalDirectoryAction(rules: ExternalDirectoryRules | readonly PermissionRule[], absolutePath: string): PermissionAction {
    let matched: PermissionAction = "ask"
    const entries = Array.isArray(rules)
        ? rules.filter((rule) => rule.action === "external_directory").map((rule) => [rule.resource, rule.effect] as const)
        : Object.entries(rules as ExternalDirectoryRules)
    for (const [pattern, action] of entries) {
        if (!patternMatches(pattern, absolutePath)) continue
        matched = action
    }
    return matched
}

export function effectiveExternalDirectoryAction(
    configRules: readonly PermissionRule[],
    agentRules: readonly PermissionRule[],
    absolutePath: string,
): PermissionAction {
    const configAction = matchExternalDirectoryAction(configRules, absolutePath)
    let agentAction: PermissionAction = "ask"
    for (const rule of agentRules) {
        if (matchesPermissionPattern(rule.action, "external_directory") && patternMatches(rule.resource, absolutePath)) {
            agentAction = rule.effect
        }
    }
    return configAction === "deny" || agentAction === "deny" ? "deny" : agentAction
}

export async function authorizeExternalContentPath(
    context: ToolContext & { externalDirectoryPermissions?: readonly PermissionRule[] },
    absolutePath: string,
    failedAction: string,
): Promise<{ ok: true } | { ok: false, response: string }> {
    const agentPermissions = context.externalDirectoryPermissions
    if (!agentPermissions) {
        return { ok: false, response: createAbortResponse(failedAction, "Effective agent external_directory permissions are unavailable") }
    }
    const { externalDirectoryPermissions } = await loadAutocodeConfig(context.worktree, context.directory)
    const action = effectiveExternalDirectoryAction(externalDirectoryPermissions, agentPermissions, absolutePath)

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
                tool: "autocode_md_read",
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
            "Add an allow/ask external_directory rule to autocode.jsonc permissions, or use a path inside the working directory.",
        ),
    }
}
