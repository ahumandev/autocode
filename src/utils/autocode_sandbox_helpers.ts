import type { SandboxDependencies } from "@/utils/sandbox"

export const bubblewrapQuickRootReadOnlyBinds = ["/bin", "/usr", "/lib", "/lib64", "/sbin", "/etc/alternatives"] as const
export const bubblewrapHostNetworkReadOnlyBinds = ["/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/hosts", "/etc/ssl", "/etc/pki", "/etc/ca-certificates", "/etc/ssl/certs/ca-certificates.crt"] as const
export const bubblewrapQuickEtcReadOnlyBinds = [...bubblewrapHostNetworkReadOnlyBinds, "/etc/passwd", "/etc/group"] as const
export const bubblewrapProxyEnvNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const

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

export async function optionalPathExists(deps: SandboxDependencies, candidatePath: string): Promise<boolean> {
    try {
        await (deps.fileSystem.lstat ?? deps.fileSystem.stat)(candidatePath)
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
    if (await optionalPathExists(deps, hostPath)) addBubblewrapBind(args, hostPath, guestPath, true)
}

export function addBubblewrapProxyEnv(args: string[], env: NodeJS.ProcessEnv): void {
    for (const name of bubblewrapProxyEnvNames) {
        const value = env[name]
        if (value) args.push("--setenv", name, value)
    }
}

export function redactProxyCredentials(input: string, env: NodeJS.ProcessEnv = process.env): string {
    return bubblewrapProxyEnvNames.reduce((redacted, name) => {
        const value = env[name]
        return value ? redacted.replaceAll(value, redactUrlCredentials(value)) : redacted
    }, input).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
}

function redactUrlCredentials(value: string): string {
    return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1[redacted]@")
}
