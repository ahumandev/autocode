export type PlatformCapabilities = {
    readonly isWindows: boolean
}

export function createPlatformCapabilities(platform: NodeJS.Platform): PlatformCapabilities {
    return { isWindows: platform === "win32" }
}
