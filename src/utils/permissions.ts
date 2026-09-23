import type { PermissionAction } from "@/config"

export type PermissionRule = { action: string; resource: string; effect: PermissionAction }

export function matchesPermissionPattern(pattern: string, value: string): boolean {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")
    return new RegExp(`^${escaped}$`, "u").test(value)
}

export function permissionEffect(rules: readonly PermissionRule[] | undefined, action: string, resource: string): PermissionAction | undefined {
    let result: PermissionAction | undefined
    for (const rule of rules ?? []) {
        if (matchesPermissionPattern(rule.action, action) && matchesPermissionPattern(rule.resource, resource)) result = rule.effect
    }
    return result
}
