import type { SandboxDependencies } from "@/utils/sandbox"

export const bubblewrapQuickRootReadOnlyBinds = ["/bin", "/usr", "/lib", "/lib64", "/sbin", "/etc/alternatives"] as const
export const bubblewrapQuickEtcReadOnlyBinds = ["/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/hosts", "/etc/passwd", "/etc/group"] as const

export async function pathExists(deps: SandboxDependencies, candidatePath: string): Promise<boolean> {
    try {
        await deps.fileSystem.stat(candidatePath)
        return true
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
    }
}

export function addBubblewrapBind(args: string[], hostPath: string, guestPath: string, readOnly: boolean): void {
    args.push(readOnly ? "--ro-bind" : "--bind", hostPath, guestPath)
}

export async function addOptionalBubblewrapReadOnlyBind(deps: SandboxDependencies, args: string[], hostPath: string, guestPath: string = hostPath): Promise<void> {
    if (await pathExists(deps, hostPath)) addBubblewrapBind(args, hostPath, guestPath, true)
}
