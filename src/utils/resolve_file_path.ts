import path from "node:path"
import type { Dirent } from "node:fs"
import { readdir, realpath, stat } from "node:fs/promises"

const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", ".cache", "coverage", ".turbo"])

/**
 * Resolves a user-supplied file reference against the current working directory
 * using a 3-step strategy:
 *
 *   1. CWD-relative match: if `path.resolve(cwd, input)` exists as a regular file,
 *      return that absolute path.
 *   2. Absolute or path-bearing input: if `input` contains a path separator
 *      (`/` or, on win32, also `\\`), trust the user and return
 *      `path.resolve(input)` without an existence check.
 *   3. Bare-filename BFS: otherwise, breadth-first search from `cwd` (max depth 7)
 *      following symlinks for the first directory that contains a regular file
 *      with the exact name `input`. Symlink cycles are avoided via `realpath`.
 *
 * Falls back to `path.resolve(cwd, input)` when none of the steps locate a file
 * so that callers performing create/write operations can still proceed with a
 * concrete path. The function never throws for a missing file and never returns
 * `undefined`.
 */
export async function resolveFilePath(
    input: string,
    cwd: string,
    opts?: { searchSubdirs?: boolean },
): Promise<string> {
    if (input === "") return path.resolve(cwd, "")

    const cwdCandidate = path.resolve(cwd, input)
    try {
        const stats = await stat(cwdCandidate)
        if (stats.isFile()) return cwdCandidate
    }
    catch {
        // Fall through to the next strategy.
    }

    const hasSeparator = input.includes(path.sep) || input.includes("/")
    if (hasSeparator) return path.resolve(input)

    if (opts?.searchSubdirs === false) return cwdCandidate

    const found = await bfsFindFilename(cwd, input, 7)
    if (found !== undefined) return found

    return cwdCandidate
}

/**
 * Breadth-first search for `filename` starting at `startDir`. `startDir` itself
 * counts as depth 0; its direct subdirectories are depth 1; traversal stops
 * after `maxDepth` levels. Symlinks are followed, and cycles are detected by
 * tracking `realpath` results. `readdir`/`realpath` errors are skipped. The
 * first directory found to contain a regular file named `filename` wins, so
 * shallower matches are preferred over deeper ones.
 */
export async function bfsFindFilename(
    startDir: string,
    filename: string,
    maxDepth: number,
): Promise<string | undefined> {
    let startReal: string
    try {
        startReal = await realpath(startDir)
    }
    catch {
        return undefined
    }

    const seen = new Set<string>([startReal])
    type QueueItem = { dir: string, depth: number }
    const queue: QueueItem[] = [{ dir: startDir, depth: 0 }]

    while (queue.length > 0) {
        const item = queue.shift()
        if (item === undefined) break
        const { dir, depth } = item

        const candidate = path.join(dir, filename)
        try {
            const stats = await stat(candidate)
            if (stats.isFile()) return candidate
        }
        catch {
            // Candidate missing; keep searching.
        }

        if (depth >= maxDepth) continue

        let entries: Dirent[]
        try {
            entries = await readdir(dir, { withFileTypes: true })
        }
        catch {
            continue
        }

        for (const entry of entries) {
            if (!entry.isSymbolicLink() && !entry.isDirectory()) continue
            if (SKIP_DIR_NAMES.has(entry.name)) continue

            const childPath = path.join(dir, entry.name)
            let realChild: string
            try {
                realChild = await realpath(childPath)
            }
            catch {
                continue
            }
            if (seen.has(realChild)) continue

            try {
                const stats = await stat(realChild)
                if (!stats.isDirectory()) continue
            }
            catch {
                continue
            }

            seen.add(realChild)
            queue.push({ dir: childPath, depth: depth + 1 })
        }
    }

    return undefined
}
