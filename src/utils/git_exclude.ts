import { execFile, type ExecFileException } from "node:child_process"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"

const runGit = promisify(execFile)
const autocodeGitExcludePattern = "/.opencode/autocode/*"
const pendingExcludes = new Map<string, Promise<void>>()

async function resolveGitExcludePath(directory: string): Promise<string | undefined> {
    try {
        const { stdout } = await runGit("git", ["-C", directory, "rev-parse", "--is-inside-work-tree", "--git-path", "info/exclude"], {
            encoding: "utf8",
            shell: false,
            windowsHide: true,
        })
        const [insideWorktree, excludePath] = stdout.trimEnd().split(/\r?\n/)
        if (insideWorktree !== "true" || !excludePath) return undefined
        return resolve(directory, excludePath)
    }
    catch (error) {
        const code = (error as ExecFileException | undefined)?.code
        if (code === "ENOENT" || typeof code === "number") return undefined
        throw error
    }
}

async function appendAutocodeGitExclude(excludePath: string): Promise<void> {
    let content = ""
    try {
        content = await readFile(excludePath, "utf8")
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error
    }

    const hasEntry = content.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).some((line: string): boolean =>
        line.trim().replace(/^#\s*/, "").trim() === autocodeGitExcludePattern)
    if (hasEntry) return

    const newline = content.match(/\r\n|\n|\r/)?.[0] ?? "\n"
    const separator = content && !/[\r\n]$/.test(content) ? newline : ""
    await mkdir(dirname(excludePath), { recursive: true })
    await appendFile(excludePath, `${separator}${autocodeGitExcludePattern}${newline}`, "utf8")
}

export async function initializeAutocodeGitExclude(directory: string): Promise<void> {
    try {
        const excludePath = await resolveGitExcludePath(directory)
        if (!excludePath) return

        const key = process.platform === "win32" ? excludePath.toLowerCase() : excludePath
        const pending = pendingExcludes.get(key)
        if (pending) {
            await pending
            return
        }

        // Coalesce startup writes across cwd instances sharing Git metadata, not later tool calls.
        const initialization = appendAutocodeGitExclude(excludePath)
        pendingExcludes.set(key, initialization)
        try {
            await initialization
        }
        finally {
            pendingExcludes.delete(key)
        }
    }
    catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        console.warn(`autocode: Git exclude initialization failed: ${typeof code === "string" && /^E[A-Z0-9_]+$/.test(code) ? code : "unknown error"}`)
    }
}
