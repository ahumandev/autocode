import { posix, win32 } from "node:path"

export const DEFAULT_MEMORY_DIRECTORY = ".opencode/autocode/memory"

function isWindowsAbsolutePath(value: string): boolean {
    return /^[a-zA-Z]:[/\\]/.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/.test(value)
}

function memoryPathFlavor(projectDirectory: string, configuredDirectory?: string): typeof posix {
    return isWindowsAbsolutePath(projectDirectory) || (configuredDirectory !== undefined && isWindowsAbsolutePath(configuredDirectory))
        ? win32
        : posix
}

export function resolveMemoryDirectory(projectDirectory: string, configuredDirectory?: string): string {
    const path = memoryPathFlavor(projectDirectory, configuredDirectory)
    const directory = configuredDirectory?.trim() ? configuredDirectory : DEFAULT_MEMORY_DIRECTORY
    return path.resolve(projectDirectory, directory)
}

export function resolveMemoryIndexPath(projectDirectory: string, configuredDirectory?: string): string {
    const path = memoryPathFlavor(projectDirectory, configuredDirectory)
    return path.join(resolveMemoryDirectory(projectDirectory, configuredDirectory), "INDEX.md")
}
