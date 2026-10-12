import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { execFile, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { initializeAutocodeGitExclude } from "./git_exclude"

const runFile = promisify(execFile)
const isWindows = process.platform === "win32"
const testTimeoutMs = isWindows ? 60_000 : 5_000
const commandTimeoutMs = isWindows ? 10_000 : 2_000
const cleanupTimeoutMs = isWindows ? 30_000 : testTimeoutMs
const recursiveRemoveOptions = { recursive: true, maxRetries: isWindows ? 5 : 0, retryDelay: 200 }
const pattern = "/.opencode/autocode/*"
const tempRoots: string[] = []
const activeChildren = new Map<ChildProcess, Promise<void>>()

function runCommand(command: string, args: string[], timeoutMs: number = commandTimeoutMs): Promise<string> {
    const execution = runFile(command, args, { encoding: "utf8", shell: false, windowsHide: true, timeout: timeoutMs, killSignal: "SIGKILL" })
    const result = execution.then(({ stdout }): string => stdout.trimEnd())
    // Observe failures even if a timed-out test stops awaiting this command.
    const settled = result.then((): void => {}, (): void => {})
    const child = execution.child
    if (!child) return result

    // Spawn errors can settle before close releases the child's file handles.
    const closed = new Promise<void>((resolve): void => {
        child.once("close", (): void => resolve())
    })
    const drained = Promise.all([closed, settled]).then((): void => {
        activeChildren.delete(child)
    })
    activeChildren.set(child, drained)
    return result
}

async function drainChildren(): Promise<void> {
    const children = Array.from(activeChildren)
    if (children.length === 0) return
    for (const [child] of children) {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            Promise.all(children.map(([, drained]): Promise<void> => drained)),
            new Promise<never>((_resolve, reject): void => {
                timer = setTimeout((): void => reject(new Error("Timed out draining test child processes")), commandTimeoutMs)
            }),
        ])
    }
    finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

async function createTempRoot(): Promise<string> {
    const scratchRoot = join(tmpdir(), "opencode")
    await mkdir(scratchRoot, { recursive: true })
    const root = await mkdtemp(join(scratchRoot, "autocode-git-exclude-"))
    tempRoots.push(root)
    return root
}

function git(args: string[]): Promise<string> {
    return runCommand("git", args)
}

async function createRepository(): Promise<{ directory: string, excludePath: string }> {
    const directory = await createTempRoot()
    await git(["-C", directory, "init", "--quiet"])
    const excludePath = resolve(directory, await git(["-C", directory, "rev-parse", "--git-path", "info/exclude"]))
    return { directory, excludePath }
}

afterEach(async (): Promise<void> => {
    mock.restore()
    await drainChildren()
    await Promise.all(tempRoots.splice(0).map((root: string): Promise<void> => rm(root, { ...recursiveRemoveOptions, force: true })))
}, cleanupTimeoutMs)

describe("Git test subprocess lifecycle", (): void => {
    const idleChildArgs = ["-e", "setInterval(() => {}, 1000)"]

    test("times out an owned child and drains it before cleanup", async (): Promise<void> => {
        const result = runCommand(process.execPath, idleChildArgs, 100)
        expect(activeChildren.size).toBe(1)

        await expect(result).rejects.toMatchObject({ killed: true, signal: "SIGKILL" })
        await drainChildren()

        expect(activeChildren.size).toBe(0)
    }, testTimeoutMs)

    test("terminates and drains an unawaited owned child without losing its rejection", async (): Promise<void> => {
        const result = runCommand(process.execPath, idleChildArgs)
        expect(activeChildren.size).toBe(1)
        let closed = false
        for (const child of activeChildren.keys()) {
            child.once("close", (): void => { closed = true })
        }

        await drainChildren()

        expect(closed).toBe(true)
        expect(activeChildren.size).toBe(0)
        await expect(result).rejects.toMatchObject({ killed: true, signal: "SIGKILL" })
    }, testTimeoutMs)

    test("drains a failed spawn without losing its rejection", async (): Promise<void> => {
        const directory = await createTempRoot()
        const result = runCommand(join(directory, "missing-child-executable"), [])

        await drainChildren()

        expect(activeChildren.size).toBe(0)
        await expect(result).rejects.toMatchObject({ code: "ENOENT" })
    }, testTimeoutMs)
})

test("skips silently when Git is unavailable", async (): Promise<void> => {
    const directory = await createTempRoot()
    const originalPath = process.env.PATH
    const warn = spyOn(console, "warn").mockImplementation((): void => {})
    process.env.PATH = ""
    try {
        await expect(initializeAutocodeGitExclude(directory)).resolves.toBeUndefined()
        expect(await readdir(directory)).toEqual([])
        expect(warn).not.toHaveBeenCalled()
    }
    finally {
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
    }
}, testTimeoutMs)

describe.skipIf(Bun.which("git") === null)("AutoCode Git exclude initialization", (): void => {
    test.each([
        ["active", `${pattern}\n`],
        ["trimmed active", ` \t${pattern} \t\r\n`],
        ["commented", `# ${pattern}\n`],
        ["no-space comment", `#${pattern}\n`],
        ["indented comment", ` \t# \t${pattern} \t\r\n`],
        ["BOM active", `\uFEFF${pattern}`],
        ["BOM comment", `\uFEFF \t#${pattern}\r\n`],
    ])("leaves %s entry byte-for-byte unchanged", async (_name: string, content: string): Promise<void> => {
        const { directory, excludePath } = await createRepository()
        await writeFile(excludePath, content)
        const original = await readFile(excludePath)

        await initializeAutocodeGitExclude(directory)
        await initializeAutocodeGitExclude(directory)

        expect(await readFile(excludePath)).toEqual(original)
    }, testTimeoutMs)

    test("appends absent entry once across repeated startup without changing .gitignore", async (): Promise<void> => {
        const { directory, excludePath } = await createRepository()
        const gitignorePath = join(directory, ".gitignore")
        const original = "# User exclusions\nlocal-only\n"
        await writeFile(excludePath, original)
        await writeFile(gitignorePath, "tracked-rule\n")

        await initializeAutocodeGitExclude(directory)
        await initializeAutocodeGitExclude(directory)

        expect(await readFile(excludePath, "utf8")).toBe(`${original}${pattern}\n`)
        expect(await readFile(gitignorePath, "utf8")).toBe("tracked-rule\n")
    }, testTimeoutMs)

    test("does not equate distinct patterns or comment text with exact entry", async (): Promise<void> => {
        const { directory, excludePath } = await createRepository()
        const original = `${pattern}*\n!${pattern}\n# ${pattern}.backup\n##${pattern}\nx${pattern}\n`
        await writeFile(excludePath, original)

        await initializeAutocodeGitExclude(directory)

        expect(await readFile(excludePath, "utf8")).toBe(`${original}${pattern}\n`)
    }, testTimeoutMs)

    test.each(["file", "info directory"])("creates missing exclude %s", async (missing: string): Promise<void> => {
        const { directory, excludePath } = await createRepository()
        await rm(missing === "file" ? excludePath : dirname(excludePath), { ...recursiveRemoveOptions, force: true })

        await initializeAutocodeGitExclude(directory)

        expect(await readFile(excludePath, "utf8")).toBe(`${pattern}\n`)
    }, testTimeoutMs)

    test.each([
        ["", `${pattern}\n`],
        ["keep", `keep\n${pattern}\n`],
        ["keep\n", `keep\n${pattern}\n`],
        ["keep\r\n", `keep\r\n${pattern}\r\n`],
        ["keep\r\nother", `keep\r\nother\r\n${pattern}\r\n`],
        ["\uFEFFkeep\r\n", `\uFEFFkeep\r\n${pattern}\r\n`],
    ])("preserves newline style and content %j", async (content: string, expected: string): Promise<void> => {
        const { directory, excludePath } = await createRepository()
        await writeFile(excludePath, content)

        await initializeAutocodeGitExclude(directory)

        expect(await readFile(excludePath, "utf8")).toBe(expected)
    }, testTimeoutMs)

    test("coalesces concurrent startup from root and subdirectory cwd", async (): Promise<void> => {
        const { directory, excludePath } = await createRepository()
        const nested = join(directory, "nested cwd with spaces")
        await mkdir(nested)
        await writeFile(excludePath, "keep")

        await Promise.all(Array.from({ length: 20 }, (_value: unknown, index: number): Promise<void> =>
            initializeAutocodeGitExclude(index % 2 === 0 ? directory : nested)))

        expect(await readFile(excludePath, "utf8")).toBe(`keep\n${pattern}\n`)
        expect(await readdir(nested)).toEqual([])
    }, testTimeoutMs)

    test("uses linked worktree common metadata from subdirectory cwd", async (): Promise<void> => {
        const { directory, excludePath } = await createRepository()
        const linked = await createTempRoot()
        await git(["-C", directory, "-c", "user.name=AutoCode Test", "-c", "user.email=autocode-test@example.invalid", "commit", "--allow-empty", "--no-gpg-sign", "--no-verify", "-m", "test"])
        await git(["-C", directory, "worktree", "add", "--detach", linked])
        const nested = join(linked, "nested cwd with spaces")
        await mkdir(nested)
        const gitFilePath = join(linked, ".git")
        const gitFile = await readFile(gitFilePath, "utf8")
        expect((await stat(gitFilePath)).isFile()).toBe(true)
        await writeFile(excludePath, "keep\r\n")

        await Promise.all([initializeAutocodeGitExclude(directory), initializeAutocodeGitExclude(linked), initializeAutocodeGitExclude(nested)])

        expect(await readFile(excludePath, "utf8")).toBe(`keep\r\n${pattern}\r\n`)
        expect(await readFile(gitFilePath, "utf8")).toBe(gitFile)
        expect(await readdir(nested)).toEqual([])
    }, testTimeoutMs)

    test("skips non-Git directory without files or warning", async (): Promise<void> => {
        const directory = await createTempRoot()
        const warn = spyOn(console, "warn").mockImplementation((): void => {})

        await initializeAutocodeGitExclude(directory)

        expect(await readdir(directory)).toEqual([])
        expect(warn).not.toHaveBeenCalled()
    }, testTimeoutMs)

    test("skips bare repository without adding project exclusion", async (): Promise<void> => {
        const directory = await createTempRoot()
        await git(["-C", directory, "init", "--bare", "--quiet"])
        const excludePath = resolve(directory, await git(["-C", directory, "rev-parse", "--git-path", "info/exclude"]))
        await writeFile(excludePath, "keep\n")
        const warn = spyOn(console, "warn").mockImplementation((): void => {})

        await initializeAutocodeGitExclude(directory)

        expect(await readFile(excludePath, "utf8")).toBe("keep\n")
        expect(warn).not.toHaveBeenCalled()
    }, testTimeoutMs)

    test("contains read failure, logs only error code, and allows later startup retry", async (): Promise<void> => {
        const { directory, excludePath } = await createRepository()
        await rm(excludePath)
        await mkdir(excludePath)
        const warn = spyOn(console, "warn").mockImplementation((): void => {})

        await expect(initializeAutocodeGitExclude(directory)).resolves.toBeUndefined()

        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0]?.[0]).toMatch(/^autocode: Git exclude initialization failed: E[A-Z0-9_]+$/)
        await rm(excludePath, recursiveRemoveOptions)
        await initializeAutocodeGitExclude(directory)
        expect(await readFile(excludePath, "utf8")).toBe(`${pattern}\n`)
        expect(warn).toHaveBeenCalledTimes(1)
    }, testTimeoutMs)
})
