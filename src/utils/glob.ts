import { Glob } from "bun"
import { existsSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "path"

export interface GlobMatch {
    /** Path key: relative to cwd if inside cwd, else absolute */
    key: string
    /** Always-absolute filesystem path */
    absolute: string
}

const GLOB_META = /[*?[{]/

/**
 * Returns the static directory prefix of an absolute glob pattern: the
 * substring before the first glob metacharacter. Falls back to "/" when no
 * static directory can be extracted (e.g. pattern starts with a metachar).
 */
function absoluteScanCwd(pattern: string): string {
    const idx = pattern.search(GLOB_META)
    if (idx <= 0) return "/"
    const prefix = pattern.slice(0, idx)
    if (prefix === "/") return "/"
    const trimmed = prefix.replace(/\/+$/, "")
    return trimmed === "" ? "/" : trimmed
}

/**
 * Expand a glob pattern to file matches, sorted by key.
 * Files inside cwd get a cwd-relative key; files outside cwd get an absolute key.
 * `onlyFiles: true` (directories excluded). Duplicate absolutes de-duplicated.
 */
export async function expandGlob(
    pattern: string,
    cwd: string,
    opts?: { accessHidden?: boolean },
): Promise<GlobMatch[]> {
    if (pattern === "") throw new Error("glob pattern must not be empty")

    // Short-circuit absolute paths without glob metacharacters: Bun's Glob
    // emits scanCwd-relative paths, which never match an absolute literal.
    // Mirror the onlyFiles: true semantic of the normal scan path so callers
    // (e.g. file readers) never receive directories or symlinks-to-dirs.
    if (isAbsolute(pattern) && !GLOB_META.test(pattern)) {
        if (!existsSync(pattern)) return []
        if (!statSync(pattern).isFile()) return []
        const relToCwd = relative(cwd, pattern)
        const outsideCwd = relToCwd === "" || relToCwd.startsWith("..") || isAbsolute(relToCwd)
        return [{ key: outsideCwd ? pattern : relToCwd, absolute: pattern }]
    }

    const scanCwd = isAbsolute(pattern) ? absoluteScanCwd(pattern) : cwd

    const glob = new Glob(pattern)
    const relPaths: string[] = []
    for await (const rel of glob.scan({
        cwd: scanCwd,
        onlyFiles: true,
        dot: opts?.accessHidden ?? false,
        absolute: false,
    })) {
        relPaths.push(rel)
    }

    const seen = new Set<string>()
    const matches: GlobMatch[] = []
    for (const rel of relPaths) {
        const absolute = resolve(scanCwd, rel)
        if (seen.has(absolute)) continue
        seen.add(absolute)

        const relToCwd = relative(cwd, absolute)
        const outsideCwd = relToCwd === "" || relToCwd.startsWith("..") || isAbsolute(relToCwd)
        matches.push({ key: outsideCwd ? absolute : relToCwd, absolute })
    }

    matches.sort((left, right) => left.key.localeCompare(right.key))
    return matches
}

/** Returns true if absolute path is inside cwd. */
export function isInsideCwd(absolute: string, cwd: string): boolean {
    const rel = relative(cwd, absolute)
    return rel !== "" && !rel.startsWith("..")
}
