export type WindowsShellKind = "cmd" | "powershell"

export type PlatformCapabilities = {
    readonly isWindows: boolean
    readonly windowsShell?: WindowsShellKind
}

export function createPlatformCapabilities(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): PlatformCapabilities {
    if (platform !== "win32") return { isWindows: false }

    return {
        isWindows: true,
        windowsShell: isPowerShellEnvironment(env) ? "powershell" : "cmd",
    }
}

function isPowerShellEnvironment(env: NodeJS.ProcessEnv): boolean {
    return (env.PSModulePath?.trim() ?? "") !== ""
        || /(?:^|[\\/])(powershell|pwsh)(?:\.exe)?$/i.test(env.SHELL ?? "")
}
