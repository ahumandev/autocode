import { permissionEffect, type PermissionRule } from "./permissions"

export function getAllowedPermissionValue(permissions: readonly PermissionRule[] | undefined, name: string): string | undefined {
    return permissionEffect(permissions, "subagent", name)
}
