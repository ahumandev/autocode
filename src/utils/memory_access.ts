import { lstat, realpath, stat } from "node:fs/promises"
import path, { posix, win32 } from "node:path"
import { resolveMemoryDirectory } from "./memory_directory"

function isWindowsAbsolutePath(value: string): boolean {
    return /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value)
}

function normalizeWindowsPath(value: string): string {
    const separators = value.replaceAll("/", "\\")
    const withoutExtendedPrefix = separators.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\(?=[a-z]:\\)/i, "")
    return win32.resolve(withoutExtendedPrefix).toLowerCase()
}

export function isPathWithin(root: string, target: string): boolean {
    const windowsRoot = isWindowsAbsolutePath(root)
    const windowsTarget = isWindowsAbsolutePath(target)
    if (windowsRoot !== windowsTarget) return false

    const flavor = windowsRoot ? win32 : posix
    const normalizedRoot = windowsRoot ? normalizeWindowsPath(root) : posix.resolve(root)
    const normalizedTarget = windowsRoot ? normalizeWindowsPath(target) : posix.resolve(target)
    const relative = flavor.relative(normalizedRoot, normalizedTarget)
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative))
}

async function resolveTraversalSegments(target: string): Promise<string> {
    const absolute = path.isAbsolute(target) ? target : `${process.cwd()}${path.sep}${target}`
    const root = path.parse(absolute).root
    const separator = process.platform === "win32" ? /[\\/]+/ : /\/+/
    const segments = absolute.slice(root.length).split(separator)
    let current = root

    for (const segment of segments) {
        if (segment === "") continue
        if (segment === "." || segment === "..") {
            // Resolve symlinks before traversing upward to preserve filesystem semantics.
            const canonical = await realpath(current)
            if (!(await stat(canonical)).isDirectory()) throw new Error(`Not a directory: ${current}`)
            current = segment === ".." ? path.dirname(canonical) : canonical
        }
        else {
            current = path.join(current, segment)
        }
    }

    if (absolute.length > root.length && separator.test(absolute.slice(-1))) current += path.sep
    return current
}

export async function canonicalizeExistingOrMissingPath(target: string): Promise<string> {
    let current = await resolveTraversalSegments(target)
    const missing: string[] = []

    while (true) {
        try {
            await lstat(current)
        }
        catch (error) {
            if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error
            const parent = path.dirname(current)
            if (parent === current) throw error
            missing.unshift(path.basename(current))
            current = parent
            continue
        }

        const canonical = await realpath(current)
        if (missing.length > 0 && !(await stat(canonical)).isDirectory()) {
            throw new Error(`Not a directory: ${current}`)
        }
        return path.join(canonical, ...missing)
    }
}

export async function classifyMemoryPath(
    projectDirectory: string,
    configuredDirectory: string | undefined,
    targetPath: string,
): Promise<"outside" | "allowed" | "denied"> {
    const root = resolveMemoryDirectory(projectDirectory, configuredDirectory)
    const flavor = isWindowsAbsolutePath(root) ? win32 : posix
    const lexicalTarget = flavor.resolve(projectDirectory, targetPath)
    if (!isPathWithin(root, lexicalTarget)) return "outside"

    try {
        if ((flavor === win32) !== (process.platform === "win32")) return "denied"
        const target = path.isAbsolute(targetPath) ? targetPath : `${projectDirectory}${path.sep}${targetPath}`
        const canonicalRoot = await canonicalizeExistingOrMissingPath(root)
        const canonicalTarget = await canonicalizeExistingOrMissingPath(target)
        return isPathWithin(canonicalRoot, canonicalTarget) ? "allowed" : "denied"
    }
    catch {
        return "denied"
    }
}
