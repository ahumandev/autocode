import type { PermissionConfig } from "@opencode-ai/sdk/v2"

function isPermissionRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function matchesPermissionPattern(value: string, pattern: string): boolean {
    if (pattern === "*") {
        return true
    }

    const escapedPattern = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*")
    return new RegExp(`^${escapedPattern}$`).test(value)
}

export function getAllowedPermissionValue(permission: PermissionConfig | undefined, name: string): string | undefined {
    if (!isPermissionRecord(permission)) {
        return undefined
    }

    const exact = permission[name]
    if (typeof exact === "string") {
        return exact
    }

    let matchedValue: string | undefined
    let matchedSpecificity = -1

    for (const [pattern, value] of Object.entries(permission)) {
        if (typeof value !== "string" || !pattern.includes("*") || !matchesPermissionPattern(name, pattern)) {
            continue
        }

        const specificity = pattern.replace(/\*/g, "").length
        if (specificity > matchedSpecificity) {
            matchedValue = value
            matchedSpecificity = specificity
        }
    }

    return matchedValue
}
