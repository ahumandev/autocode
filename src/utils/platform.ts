export type WindowsShellKind = "cmd" | "powershell"
export type CommandEnvironment = "linux" | WindowsShellKind

export type PlatformCapabilities = {
    readonly isWindows: boolean
    readonly commandEnvironment?: CommandEnvironment
    readonly windowsShell?: WindowsShellKind
}

export function createPlatformCapabilities(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): PlatformCapabilities {
    if (platform !== "win32") return { isWindows: false, commandEnvironment: "linux" }

    const windowsShell = isPowerShellEnvironment(env) ? "powershell" : "cmd"
    return {
        isWindows: true,
        commandEnvironment: windowsShell,
        windowsShell,
    }
}

function isPowerShellEnvironment(env: NodeJS.ProcessEnv): boolean {
    return (env.PSModulePath?.trim() ?? "") !== ""
        || /(?:^|[\\/])(powershell|pwsh)(?:\.exe)?$/i.test(env.SHELL ?? "")
}
