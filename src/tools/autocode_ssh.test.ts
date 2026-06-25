import { EventEmitter } from "node:events"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import type { ConnectConfig, FileEntryWithStats, Stats } from "ssh2"
import { createToolContext } from "./test_context"
import { createTools } from "./index"
import {
    createAutocodeSshCommandTool,
    createAutocodeSshEditFileTool,
    createAutocodeSshGlobTool,
    createAutocodeSshGrepFileTool,
    createAutocodeSshListTool,
    createAutocodeSshPatchFileTool,
    createAutocodeSshReadAttributesTool,
    createAutocodeSshReadFileTool,
    createAutocodeSshWriteAttributesTool,
    createAutocodeSshWriteFileTool,
} from "./autocode_ssh"
import type { SftpLike, SshChannelLike, SshClientLike, SshConnectionPool, SshReadableLike, SshResolvedConfig } from "../utils/ssh"

type CommandOutput = { stdout?: string; stderr?: string; exitCode?: number }
type SshToolErrorResponse = { failedAction?: unknown; error?: unknown; instruction?: unknown }

const envWithPassword = {
    AUTOCODE_SSH_DEV_HOST: "ssh.example:2200",
    AUTOCODE_SSH_DEV_USERNAME: "devuser",
    AUTOCODE_SSH_DEV_PASSWORD: "secret",
} satisfies NodeJS.ProcessEnv

function parseToolResult<T = Record<string, unknown>>(result: string | { output: string }): T {
    return JSON.parse(typeof result === "string" ? result : result.output) as T
}

function expectJsonString<T = Record<string, unknown>>(result: unknown): T {
    expect(typeof result).toBe("string")
    expect(() => JSON.parse(result as string)).not.toThrow()
    return JSON.parse(result as string) as T
}

function expectSshErrorJsonString(result: unknown, failedAction: string, errorText: string): SshToolErrorResponse {
    const parsed = expectJsonString<SshToolErrorResponse>(result)
    expect(parsed).toEqual(expect.objectContaining({
        failedAction,
        error: expect.stringContaining(errorText),
        instruction: expect.any(String),
    }))
    expect(parsed.instruction).toEqual(expect.stringContaining("Report the SSH failure"))
    return parsed
}

class FakeReadable extends EventEmitter implements SshReadableLike {
}

class FakeChannel extends FakeReadable implements SshChannelLike {
    readonly stderr = new FakeReadable()
}

class FakeClient extends EventEmitter implements SshClientLike {
    readonly commands: string[] = []

    constructor(private readonly sftpInstance: SftpLike, private readonly outputForCommand: (command: string) => CommandOutput = () => ({ stdout: "" })) {
        super()
    }

    connect(_config: ConnectConfig): void {
    }

    exec(command: string, callback: (err: Error | undefined, channel: SshChannelLike) => void): void {
        this.commands.push(command)
        const channel = new FakeChannel()
        callback(undefined, channel)
        queueMicrotask(() => {
            const output = this.outputForCommand(command)
            if (output.stdout) channel.emit("data", output.stdout)
            if (output.stderr) channel.stderr.emit("data", output.stderr)
            channel.emit("exit", output.exitCode ?? 0, undefined)
            channel.emit("close")
        })
    }

    sftp(callback: (err: Error | undefined, sftp: SftpLike) => void): void {
        callback(undefined, this.sftpInstance)
    }

    end(): void {
    }
}

class FakeSftp implements SftpLike {
    readonly writes: Array<{ path: string; data: string }> = []
    readonly mkdirs: string[] = []
    readonly readFileCalls: string[] = []
    readonly readdirCalls: string[] = []
    writeError?: Error

    constructor(
        private readonly files: Record<string, string> = {},
        private readonly stats: Record<string, Stats> = {},
        private readonly entries: Record<string, string[]> = {},
        private readonly missingPaths = new Set<string>()
    ) {
    }

    readFile(path: string, callback: (err: Error | undefined, data: Buffer) => void): void
    readFile(path: string, encoding: BufferEncoding, callback: (err: Error | undefined, data: Buffer) => void): void
    readFile(path: string, encodingOrCallback: BufferEncoding | ((err: Error | undefined, data: Buffer) => void), maybeCallback?: (err: Error | undefined, data: Buffer) => void): void {
        this.readFileCalls.push(path)
        const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback
        if (this.missingPaths.has(path)) {
            callback?.(createMissingRemoteError(), Buffer.from(""))
            return
        }
        callback?.(undefined, Buffer.from(this.files[path] ?? ""))
    }

    writeFile(path: string, data: string | Buffer, callback: (err: Error | undefined) => void): void {
        if (this.writeError) {
            callback(this.writeError)
            return
        }
        this.files[path] = String(data)
        this.writes.push({ path, data: String(data) })
        callback(undefined)
    }

    stat(path: string, callback: (err: Error | undefined, stats: Stats) => void): void {
        if (this.missingPaths.has(path)) {
            callback(createMissingRemoteError(), createStats())
            return
        }
        callback(undefined, this.stats[path] ?? createStats())
    }

    readdir(path: string, callback: (err: Error | undefined, list: FileEntryWithStats[]) => void): void {
        this.readdirCalls.push(path)
        callback(undefined, (this.entries[path] ?? []).map((filename) => ({ filename, attrs: this.stats[joinRemotePath(path, filename)] ?? createStats() }) as FileEntryWithStats))
    }

    mkdir(path: string, callback: (err: Error | undefined) => void): void {
        this.mkdirs.push(path)
        callback(undefined)
    }

    unlink(_path: string, callback: (err: Error | undefined) => void): void {
        callback(undefined)
    }
}

function createStats(overrides: Partial<Stats> = {}): Stats {
    return {
        mode: 0o100640,
        size: 123,
        mtime: 0,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        ...overrides,
    } as Stats
}

function createMissingRemoteError(): Error {
    return new Error("No such file")
}

function joinRemotePath(directory: string, filename: string): string {
    return directory === "/" ? `/${filename}` : `${directory}/${filename}`
}

function createFakePool(client: FakeClient): { configs: SshResolvedConfig[]; pool: SshConnectionPool } {
    const configs: SshResolvedConfig[] = []
    const pool = {
        async get(config: SshResolvedConfig): Promise<SshClientLike> {
            configs.push(config)
            return client
        },
        release(_config: SshResolvedConfig): void {
        },
    }

    return { configs, pool: pool as unknown as SshConnectionPool }
}

function createCommandOutput(command: string): CommandOutput {
    if (command.startsWith("stat -c")) return { stdout: "alice\tstaff\tregular file\t754\t4096\n" }
    if (command.startsWith("chmod") || command.startsWith("chown") || command.startsWith("chgrp")) return { stdout: "" }
    return { stdout: "ok\n", stderr: "warn\n" }
}

describe("autocode_ssh tools", () => {
    test("command uses env password auth and reports untruncated output", async () => {
        const client = new FakeClient(new FakeSftp(), () => ({ stdout: "ok\n", stderr: "warn\n" }))
        const { configs, pool } = createFakePool(client)
        const tool = createAutocodeSshCommandTool({ env: envWithPassword, pool })

        const result = await tool.execute({ ssh_key: "dev", command: "uptime", max_characters: 20 }, createToolContext())
        const payload = parseToolResult(result)

        expect(Object.keys(payload)).toEqual(["host", "port", "output", "output_truncated"])
        expect(payload).toEqual({ host: "ssh.example", port: 2200, output: "ok\nwarn\n", output_truncated: false })
        expect(configs[0].connectConfig.password).toBe("secret")
        expect(client.commands).toEqual(["uptime"])
    })

    test("command truncates by max_characters", async () => {
        const client = new FakeClient(new FakeSftp(), () => ({ stdout: "line1\nline2\nline3" }))
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshCommandTool({ env: envWithPassword, pool })

        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", command: "cat log", max_characters: 6 }, createToolContext()))

        expect(payload.output).toBe("line3")
        expect(payload.output_truncated).toBe(true)
    })

    test("command prefers readable keyfile over password", async () => {
        const directory = await mkdtemp(join(tmpdir(), "autocode-ssh-"))
        const keyPath = join(directory, "id_ed25519")
        await writeFile(keyPath, "real-key")
        const readPaths: string[] = []
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const tool = createAutocodeSshCommandTool({
            env: { ...envWithPassword, AUTOCODE_SSH_DEV_KEYFILE: keyPath },
            fs: {
                readFile(path: string): string {
                    readPaths.push(path)
                    return "fake-key"
                },
            },
            pool,
        })

        await tool.execute({ ssh_key: "dev", command: "whoami" }, createToolContext())

        expect(readPaths).toEqual([keyPath])
        expect(configs[0].auth.method).toBe("privateKey")
        expect(configs[0].connectConfig.privateKey).toBe("fake-key")
        expect(configs[0].connectConfig.password).toBeUndefined()
    })

    test("command falls back to password for nonexistent keyfile", async () => {
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const tool = createAutocodeSshCommandTool({
            env: { ...envWithPassword, AUTOCODE_SSH_DEV_KEYFILE: "/missing/autocode-key" },
            pool,
        })

        await tool.execute({ ssh_key: "dev", command: "whoami" }, createToolContext())

        expect(configs[0].auth.method).toBe("password")
        expect(configs[0].connectConfig.password).toBe("secret")
    })

    test("list applies name, extension, and max filters with exact fields", async () => {
        const sftp = new FakeSftp({}, {}, { "/var/log": ["app.log", "app.txt", "db.log", "my-app.log"] }) as SftpLike
        const client = new FakeClient(sftp)
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshListTool({ env: envWithPassword, pool })

        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", directory: "/var/log", name_filter: "app", ext_filter: "log", max_items: 1 }, createToolContext()))

        expect(Object.keys(payload)).toEqual(["host", "port", "list", "list_truncated"])
        expect(payload).toEqual({ host: "ssh.example", port: 2200, list: ["/var/log/app.log"], list_truncated: true })
    })

    test("read attributes parses stat fields with exact payload fields", async () => {
        const sftp = new FakeSftp({}, { "/srv/file.txt": createStats({ size: 1 }) }) as SftpLike
        const client = new FakeClient(sftp, createCommandOutput)
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshReadAttributesTool({ env: envWithPassword, pool })

        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt" }, createToolContext()))

        expect(Object.keys(payload)).toEqual(["host", "port", "path", "type", "owner", "group", "permission", "size"])
        expect(payload).toEqual({
            host: "ssh.example",
            port: 2200,
            path: "/srv/file.txt",
            type: "file",
            owner: "alice",
            group: "staff",
            permission: { read: ["owner", "group", "other"], write: ["owner"], execute: ["owner", "group"] },
            size: 4096,
        })
    })

    test("write attributes preserves unspecified permissions and returns exact fields", async () => {
        const client = new FakeClient(new FakeSftp() as SftpLike, createCommandOutput)
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshWriteAttributesTool({ env: envWithPassword, pool })

        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", execute: ["owner"], owner: "bob", group: "ops" }, createToolContext()))

        expect(Object.keys(payload)).toEqual(["host", "port", "path", "owner", "group", "permission"])
        expect(client.commands).toEqual([
            "stat -c '%U\t%G\t%F\t%a\t%s' -- '/srv/file.txt'",
            "chown -- 'bob' '/srv/file.txt'",
            "chgrp -- 'ops' '/srv/file.txt'",
            "chmod u+x,g-x,o-x -- '/srv/file.txt'",
            "stat -c '%U\t%G\t%F\t%a\t%s' -- '/srv/file.txt'",
        ])
        expect(payload).toEqual({
            host: "ssh.example",
            port: 2200,
            path: "/srv/file.txt",
            owner: "alice",
            group: "staff",
            permission: { read: ["owner", "group", "other"], write: ["owner"], execute: ["owner", "group"] },
        })
    })

    test("read_file line bounds are inclusive", async () => {
        const sftp = new FakeSftp({ "/tmp/file.txt": "one\ntwo\nthree\nfour\n" }) as SftpLike
        const client = new FakeClient(sftp)
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshReadFileTool({ env: envWithPassword, pool })

        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/tmp/file.txt", first_line: 2, last_line: 3 }, createToolContext()))

        expect(Object.keys(payload)).toEqual(["host", "port", "path", "content", "content_truncated"])
        expect(payload).toEqual({ host: "ssh.example", port: 2200, path: "/tmp/file.txt", content: "two\nthree\n", content_truncated: false })
    })

    test("read_file truncates content at 2000 characters", async () => {
        const sftp = new FakeSftp({ "/tmp/large.txt": "x".repeat(2001) }) as SftpLike
        const client = new FakeClient(sftp)
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshReadFileTool({ env: envWithPassword, pool })

        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/tmp/large.txt" }, createToolContext()))

        expect(String(payload.content).length).toBe(2000)
        expect(payload.content_truncated).toBe(true)
    })

    test("invalid bounds and missing config/auth return shared error keys", async () => {
        const readFileTool = createAutocodeSshReadFileTool({ env: envWithPassword })
        const invalidBounds = parseToolResult(await readFileTool.execute({ ssh_key: "dev", path: "/tmp/file", first_line: 3, last_line: 2 }, createToolContext()))
        const missingConfig = parseToolResult(await createAutocodeSshCommandTool({ env: {} }).execute({ ssh_key: "dev", command: "ls" }, createToolContext()))
        const missingAuth = parseToolResult(await createAutocodeSshCommandTool({ env: { AUTOCODE_SSH_DEV_HOST: "ssh.example", AUTOCODE_SSH_DEV_USERNAME: "devuser" } }).execute({ ssh_key: "dev", command: "ls" }, createToolContext()))

        expect(Object.keys(invalidBounds)).toEqual(["failedAction", "error", "instruction"])
        expect(Object.keys(missingConfig)).toEqual(["failedAction", "error", "instruction"])
        expect(Object.keys(missingAuth)).toEqual(["failedAction", "error", "instruction"])
    })

    test("write_file rejects bad paths, writes content, creates directories, and reports write failures", async () => {
        const sftp = new FakeSftp({ "/srv/existing.txt": "old" }, {
            "/srv": createStats({ isFile: () => false, isDirectory: () => true }),
            "/srv/existing.txt": createStats(),
            "/srv/directory": createStats({ isFile: () => false, isDirectory: () => true }),
        }, {}, new Set(["/srv/new/file.txt", "/srv/new", "/missing", "/missing/file.txt"]))
        const { pool } = createFakePool(new FakeClient(sftp))
        const tool = createAutocodeSshWriteFileTool({ env: envWithPassword, pool })

        expect(parseToolResult(await tool.execute({ ssh_key: "dev", path: "", content: "x" }, createToolContext())).error).toContain("non-empty")
        expect(parseToolResult(await tool.execute({ ssh_key: "dev", path: "/tmp/nu\0l", content: "x" }, createToolContext())).error).toContain("NUL")
        expect(parseToolResult(await tool.execute({ ssh_key: "dev", path: "/", content: "x" }, createToolContext())).error).toContain("root directory")
        expect(parseToolResult(await tool.execute({ ssh_key: "dev", path: "/tmp/", content: "x" }, createToolContext())).error).toContain("end with a slash")
        expect(parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/directory", content: "x" }, createToolContext())).error).toContain("directory")
        expect(parseToolResult(await tool.execute({ ssh_key: "dev", path: "/missing/file.txt", content: "x", create_dirs: false }, createToolContext())).error).toContain("parent directory does not exist")

        const createdRaw = await tool.execute({ ssh_key: "dev", path: "/srv/new/file.txt", content: "hello", create_dirs: true }, createToolContext())
        const created = expectJsonString(createdRaw)
        const updated = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/existing.txt", content: "snowman ☃" }, createToolContext()))
        const emptied = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/existing.txt", content: "" }, createToolContext()))

        expect(created).toEqual({ operation: "write", path: "/srv/new/file.txt", bytes: 5, existed: false })
        expect(updated).toEqual({ operation: "write", path: "/srv/existing.txt", bytes: 11, existed: true })
        expect(emptied).toEqual({ operation: "write", path: "/srv/existing.txt", bytes: 0, existed: true })
        expect(sftp.mkdirs).toEqual(["/srv", "/srv/new"])
        expect(sftp.writes.map((write) => write.data)).toEqual(["hello", "snowman ☃", ""])

        sftp.writeError = new Error("write denied")
        expect(parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/existing.txt", content: "fail" }, createToolContext())).error).toContain("write denied")
    })

    test("edit_file validates replacements and writes exact or all matches", async () => {
        const sftp = new FakeSftp({ "/srv/file.txt": "alpha beta alpha\n", "/srv/one.txt": "hello world\n" }, { "/srv/file.txt": createStats(), "/srv/one.txt": createStats() }, {}, new Set(["/srv/new.txt"]))
        const { pool } = createFakePool(new FakeClient(sftp))
        const tool = createAutocodeSshEditFileTool({ env: envWithPassword, pool })

        expect(parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/one.txt", oldString: "same", newString: "same" }, createToolContext())).error).toContain("must differ")
        expect(parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/nu\0l.txt", oldString: "a", newString: "b" }, createToolContext())).error).toContain("NUL")

        const exactRaw = await tool.execute({ ssh_key: "dev", path: "/srv/one.txt", oldString: "world", newString: "there" }, createToolContext())
        const exact = expectJsonString(exactRaw)
        expect(exact).toEqual({ operation: "edit", path: "/srv/one.txt", existed: true, replacements: 1, bytes: 12 })
        expect(sftp.writes.at(-1)).toEqual({ path: "/srv/one.txt", data: "hello there\n" })

        const writesBeforeMismatch = sftp.writes.length
        const mismatch = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/one.txt", oldString: "missing", newString: "x" }, createToolContext()))
        expect(mismatch.error).toContain("oldString was not found")
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const emptyExisting = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/one.txt", oldString: "", newString: "x", replaceAll: true }, createToolContext()))
        expect(emptyExisting.error).toContain("oldString must not be empty")
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const multiple = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", oldString: "alpha", newString: "omega" }, createToolContext()))
        expect(multiple.error).toContain("multiple locations")
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const multipleFalse = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", oldString: "alpha", newString: "omega", replaceAll: false }, createToolContext()))
        expect(multipleFalse.error).toContain("multiple locations")
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const all = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", oldString: "alpha", newString: "omega", replaceAll: true }, createToolContext()))
        expect(all).toEqual({ operation: "edit", path: "/srv/file.txt", existed: true, replacements: 2, bytes: 17 })
        expect(sftp.writes.at(-1)).toEqual({ path: "/srv/file.txt", data: "omega beta omega\n" })

        const created = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/new.txt", oldString: "", newString: "created" }, createToolContext()))
        expect(created).toEqual({ operation: "edit", path: "/srv/new.txt", existed: false, replacements: 1, bytes: 7 })
    })

    test("patch_file applies unified hunks and does not write mismatches", async () => {
        const sftp = new FakeSftp({ "/srv/file.txt": "one\ntwo\nthree\n" }, { "/srv/file.txt": createStats() })
        const { pool } = createFakePool(new FakeClient(sftp))
        const tool = createAutocodeSshPatchFileTool({ env: envWithPassword, pool })

        const successRaw = await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "@@ -2,1 +2,2 @@\n-two\n+TWO\n+deux\n" }, createToolContext())
        const success = expectJsonString(successRaw)

        expect(success).toEqual({ operation: "patch", path: "/srv/file.txt", hunks: 1, additions: 2, removals: 1, bytes: 19 })
        expect(sftp.writes.at(-1)).toEqual({ path: "/srv/file.txt", data: "one\nTWO\ndeux\nthree\n" })

        const multiHunk = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "@@ -1,1 +1,1 @@\n-one\n+ONE\n@@ -4,1 +4,1 @@\n-three\n+THREE\n" }, createToolContext()))
        expect(multiHunk).toEqual({ operation: "patch", path: "/srv/file.txt", hunks: 2, additions: 2, removals: 2, bytes: 19 })
        expect(sftp.writes.at(-1)).toEqual({ path: "/srv/file.txt", data: "ONE\nTWO\ndeux\nTHREE\n" })

        const writesBeforeMismatch = sftp.writes.length
        const mismatch = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "@@ -1,1 +1,1 @@\n-missing\n+found\n" }, createToolContext()))
        expect(mismatch.error).toContain("mismatch")
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const malformed = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "@@ nope\n-old\n+new\n" }, createToolContext()))
        expect(malformed.error).toContain("malformed hunk header")
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const missingHunk = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "--- a/file\n+++ b/file\n" }, createToolContext()))
        expect(missingHunk.error).toContain("no hunks")
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const badCount = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "@@ -1,2 +1,1 @@\n-ONE\n+one\n" }, createToolContext()))
        expect(badCount.error).toContain("expected 2")
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const unsupported = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "rename from old.txt\n@@ -1,1 +1,1 @@\n-ONE\n+one\n" }, createToolContext()))
        expect(unsupported.error).toContain("unsupported patch file operation")
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const unsupportedCreate = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "new file mode 100644\n@@ -1,0 +1,1 @@\n+created\n" }, createToolContext()))
        const unsupportedDelete = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "deleted file mode 100644\n@@ -1,1 +0,0 @@\n-ONE\n" }, createToolContext()))
        expect(unsupportedCreate.error).toContain("unsupported patch file operation")
        expect(unsupportedDelete.error).toContain("unsupported patch file operation")
        expect(sftp.writes.length).toBe(writesBeforeMismatch)
    })

    test("glob supports recursive wildcards, single-character wildcards, limits, metadata, and no matches", async () => {
        const sftp = new FakeSftp({}, {
            "/": createStats({ isFile: () => false, isDirectory: () => true, size: 0 }),
            "/repo": createStats({ isFile: () => false, isDirectory: () => true, size: 0 }),
            "/repo/src": createStats({ isFile: () => false, isDirectory: () => true, size: 0 }),
            "/repo/src/a.ts": createStats({ size: 10, mtime: 1 }),
            "/repo/src/b.test.ts": createStats({ size: 20, mtime: 2 }),
            "/repo/src/lib": createStats({ isFile: () => false, isDirectory: () => true, size: 0 }),
            "/repo/src/lib/c.ts": createStats({ size: 30, mtime: 3 }),
            "/repo/src/lib/cd.ts": createStats({ size: 40, mtime: 4 }),
        }, {
            "/": ["repo"],
            "/repo": ["src"],
            "/repo/src": ["a.ts", "b.test.ts", "lib"],
            "/repo/src/lib": ["c.ts", "cd.ts"],
        })
        const { pool } = createFakePool(new FakeClient(sftp))
        const tool = createAutocodeSshGlobTool({ env: envWithPassword, pool })

        const absolute = parseToolResult<Record<string, unknown>[]>(await tool.execute({ ssh_key: "dev", pattern: "/repo/**/*.ts" }, createToolContext()))
        const recursiveRaw = await tool.execute({ ssh_key: "dev", pattern: "**/*.ts", path: "/repo/src", limit: 3 }, createToolContext())
        const recursive = expectJsonString<Record<string, unknown>[]>(recursiveRaw)
        const nested = parseToolResult<Record<string, unknown>[]>(await tool.execute({ ssh_key: "dev", pattern: "src/*.ts", path: "/repo" }, createToolContext()))
        const single = parseToolResult<Record<string, unknown>[]>(await tool.execute({ ssh_key: "dev", pattern: "lib/?.ts", path: "/repo/src" }, createToolContext()))
        const matchedFile = parseToolResult<Record<string, unknown>[]>(await tool.execute({ ssh_key: "dev", pattern: "*.ts", path: "/repo/src/a.ts" }, createToolContext()))
        const unmatchedFile = parseToolResult<Record<string, unknown>[]>(await tool.execute({ ssh_key: "dev", pattern: "*.md", path: "/repo/src/a.ts" }, createToolContext()))
        const none = parseToolResult<Record<string, unknown>[]>(await tool.execute({ ssh_key: "dev", pattern: "**/*.md", path: "/repo/src" }, createToolContext()))

        expect(absolute.map((entry) => entry.path)).toEqual(["/repo/src/a.ts", "/repo/src/b.test.ts", "/repo/src/lib/c.ts", "/repo/src/lib/cd.ts"])
        expect(recursive).toEqual([
            { path: "/repo/src/a.ts", type: "file", size: 10, modified: "1970-01-01T00:00:01.000Z" },
            { path: "/repo/src/b.test.ts", type: "file", size: 20, modified: "1970-01-01T00:00:02.000Z" },
            { path: "/repo/src/lib/c.ts", type: "file", size: 30, modified: "1970-01-01T00:00:03.000Z" },
        ])
        expect(nested.map((entry) => entry.path)).toEqual(["/repo/src/a.ts", "/repo/src/b.test.ts"])
        expect(single).toEqual([{ path: "/repo/src/lib/c.ts", type: "file", size: 30, modified: "1970-01-01T00:00:03.000Z" }])
        expect(matchedFile).toEqual([{ path: "/repo/src/a.ts", type: "file", size: 10, modified: "1970-01-01T00:00:01.000Z" }])
        expect(unmatchedFile).toEqual([])
        expect(none).toEqual([])

        const invalidPattern = parseToolResult(await tool.execute({ ssh_key: "dev", pattern: "", path: "/repo" }, createToolContext()))
        const invalidPath = parseToolResult(await tool.execute({ ssh_key: "dev", pattern: "*.ts", path: "" }, createToolContext()))
        const invalidLimit = parseToolResult(await tool.execute({ ssh_key: "dev", pattern: "*.ts", path: "/repo", limit: 0 }, createToolContext()))
        expect(invalidPattern.error).toContain("pattern must be a non-empty string")
        expect(invalidPath.error).toContain("path must be a non-empty string")
        expect(invalidLimit.error).toContain("positive integer")

        const limitedSftp = new FakeSftp({}, {
            "/repo": createStats({ isFile: () => false, isDirectory: () => true }),
            "/repo/a.ts": createStats(),
            "/repo/deep": createStats({ isFile: () => false, isDirectory: () => true }),
            "/repo/deep/b.ts": createStats(),
        }, { "/repo": ["a.ts", "deep"], "/repo/deep": ["b.ts"] })
        const limitedTool = createAutocodeSshGlobTool({ env: envWithPassword, pool: createFakePool(new FakeClient(limitedSftp)).pool })
        const limited = parseToolResult<Record<string, unknown>[]>(await limitedTool.execute({ ssh_key: "dev", pattern: "**/*.ts", path: "/repo", limit: 1 }, createToolContext()))
        expect(limited.map((entry) => entry.path)).toEqual(["/repo/a.ts"])
        expect(limitedSftp.readdirCalls).toEqual(["/repo"])
    })

    test("grep_file handles invalid regex, no matches, include filters, match fields, and limits", async () => {
        const sftp = new FakeSftp({
            "/repo/src/app.ts": "alpha\nbeta alpha\n",
            "/repo/src/app.test.ts": "alpha test\n",
            "/repo/src/readme.md": "alpha docs\n",
        }, {
            "/repo/src": createStats({ isFile: () => false, isDirectory: () => true }),
            "/repo/src/app.ts": createStats(),
            "/repo/src/app.test.ts": createStats(),
            "/repo/src/readme.md": createStats(),
        }, { "/repo/src": ["app.ts", "app.test.ts", "readme.md"] })
        const { pool } = createFakePool(new FakeClient(sftp))
        const tool = createAutocodeSshGrepFileTool({ env: envWithPassword, pool })

        const invalid = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/repo/src", pattern: "[" }, createToolContext()))
        const none = parseToolResult<Record<string, unknown>[]>(await tool.execute({ ssh_key: "dev", path: "/repo/src", pattern: "nomatch" }, createToolContext()))
        const matchesRaw = await tool.execute({ ssh_key: "dev", path: "/repo/src", pattern: "alpha", include: "app.ts", limit: 2 }, createToolContext())
        const matches = expectJsonString<Record<string, unknown>[]>(matchesRaw)
        const filePathMatches = parseToolResult<Record<string, unknown>[]>(await tool.execute({ ssh_key: "dev", path: "/repo/src/app.ts", pattern: "alpha", include: "*.ts" }, createToolContext()))
        const filePathExcluded = parseToolResult<Record<string, unknown>[]>(await tool.execute({ ssh_key: "dev", path: "/repo/src/app.ts", pattern: "alpha", include: "*.md" }, createToolContext()))

        expect(invalid.error).toContain("Invalid regular expression")
        expect(none).toEqual([])
        expect(matches).toEqual([
            { path: "/repo/src/app.ts", line: 1, column: 1, text: "alpha" },
            { path: "/repo/src/app.ts", line: 2, column: 6, text: "beta alpha" },
        ])
        expect(filePathMatches).toEqual([
            { path: "/repo/src/app.ts", line: 1, column: 1, text: "alpha" },
            { path: "/repo/src/app.ts", line: 2, column: 6, text: "beta alpha" },
        ])
        expect(filePathExcluded).toEqual([])

        const fileOnlySftp = new FakeSftp({
            "/repo/src/app.ts": "alpha\n",
            "/repo/src/sibling.ts": "alpha\n",
        }, { "/repo/src/app.ts": createStats(), "/repo/src/sibling.ts": createStats() })
        const fileOnlyTool = createAutocodeSshGrepFileTool({ env: envWithPassword, pool: createFakePool(new FakeClient(fileOnlySftp)).pool })
        const fileOnly = parseToolResult<Record<string, unknown>[]>(await fileOnlyTool.execute({ ssh_key: "dev", path: "/repo/src/app.ts", pattern: "alpha" }, createToolContext()))
        expect(fileOnly.map((entry) => entry.path)).toEqual(["/repo/src/app.ts"])
        expect(fileOnlySftp.readFileCalls).toEqual(["/repo/src/app.ts"])

        const limitedSftp = new FakeSftp({
            "/repo/a.ts": "alpha\n",
            "/repo/deep/b.ts": "alpha\n",
        }, {
            "/repo": createStats({ isFile: () => false, isDirectory: () => true }),
            "/repo/a.ts": createStats(),
            "/repo/deep": createStats({ isFile: () => false, isDirectory: () => true }),
            "/repo/deep/b.ts": createStats(),
        }, { "/repo": ["a.ts", "deep"], "/repo/deep": ["b.ts"] })
        const limitedTool = createAutocodeSshGrepFileTool({ env: envWithPassword, pool: createFakePool(new FakeClient(limitedSftp)).pool })
        const limited = parseToolResult<Record<string, unknown>[]>(await limitedTool.execute({ ssh_key: "dev", path: "/repo", pattern: "alpha", limit: 1 }, createToolContext()))
        expect(limited.map((entry) => entry.path)).toEqual(["/repo/a.ts"])
        expect(limitedSftp.readdirCalls).toEqual(["/repo"])
        expect(limitedSftp.readFileCalls).toEqual(["/repo/a.ts"])
    })

    test("remote file tools return safe JSON error strings for representative failures", async () => {
        const globTool = createAutocodeSshGlobTool({ env: envWithPassword, pool: createFakePool(new FakeClient(new FakeSftp())).pool })
        const globRaw = await globTool.execute({ ssh_key: "dev", pattern: "*.ts", path: "/repo", limit: 0 }, createToolContext())
        expectSshErrorJsonString(globRaw, "glob SSH files", "limit must be a positive integer")

        const grepTool = createAutocodeSshGrepFileTool({ env: envWithPassword, pool: createFakePool(new FakeClient(new FakeSftp())).pool })
        const grepRaw = await grepTool.execute({ ssh_key: "dev", path: "/repo/src", pattern: "[" }, createToolContext())
        expectSshErrorJsonString(grepRaw, "grep SSH file", "Invalid regular expression")

        const patchSftp = new FakeSftp({ "/srv/file.txt": "one\n" }, { "/srv/file.txt": createStats() })
        const patchTool = createAutocodeSshPatchFileTool({ env: envWithPassword, pool: createFakePool(new FakeClient(patchSftp)).pool })
        const patchRaw = await patchTool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "rename from old.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n" }, createToolContext())
        expectSshErrorJsonString(patchRaw, "patch SSH file", "unsupported patch file operation")

        const editTool = createAutocodeSshEditFileTool({ env: envWithPassword, pool: createFakePool(new FakeClient(new FakeSftp({ "/srv/one.txt": "same\n" }))).pool })
        const editRaw = await editTool.execute({ ssh_key: "dev", path: "/srv/one.txt", oldString: "same", newString: "same" }, createToolContext())
        expectSshErrorJsonString(editRaw, "edit SSH file", "oldString and newString must differ")

        const writeTool = createAutocodeSshWriteFileTool({ env: envWithPassword, pool: createFakePool(new FakeClient(new FakeSftp())).pool })
        const writeRaw = await writeTool.execute({ ssh_key: "dev", path: "/srv/file.txt/", content: "x" }, createToolContext())
        expectSshErrorJsonString(writeRaw, "write SSH file", "path must point to a file")
    })

    test("createTools wires SSH tool names", () => {
        const tools = createTools({} as Parameters<typeof createTools>[0])

        expect(Object.keys(tools).filter((name) => name.startsWith("autocode_ssh_")).sort()).toEqual([
            "autocode_ssh_command",
            "autocode_ssh_edit_file",
            "autocode_ssh_glob",
            "autocode_ssh_grep_file",
            "autocode_ssh_list",
            "autocode_ssh_patch_file",
            "autocode_ssh_read_attributes",
            "autocode_ssh_read_file",
            "autocode_ssh_write_attributes",
            "autocode_ssh_write_file",
        ].sort())
    })
})
