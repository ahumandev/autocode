import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"
import type { ConnectConfig, FileEntryWithStats, Stats } from "ssh2"
import type { SftpLike, SshChannelLike, SshClientLike, SshConnectionPool, SshResolvedConfig } from "../utils/ssh"
import { createToolContext } from "./test_context"
import { createRemoteConfigExecute } from "./config/ssh/adapter"
import { createAutocodeSshConfigRemoveTool } from "./autocode_ssh_config_remove"

const envWithPassword = {
    AUTOCODE_SSH_DEV_HOST: "ssh.example:2200",
    AUTOCODE_SSH_DEV_USERNAME: "devuser",
    AUTOCODE_SSH_DEV_PASSWORD: "secret",
} satisfies NodeJS.ProcessEnv

class MemorySftp implements SftpLike {
    readonly files = new Map<string, string>()
    readonly readFileCalls: string[] = []
    readonly writeFileCalls: Array<{ path: string; data: string }> = []
    readonly renameCalls: Array<{ oldPath: string; newPath: string }> = []
    readonly unlinkCalls: string[] = []
    readonly missing = new Set<string>()

    constructor(initial: Record<string, string> = {}) {
        for (const [key, value] of Object.entries(initial)) this.files.set(key, value)
    }

    readFile(path: string, callback: (err: Error | undefined, data: Buffer) => void): void
    readFile(path: string, encoding: BufferEncoding, callback: (err: Error | undefined, data: Buffer) => void): void
    readFile(path: string, encodingOrCallback: BufferEncoding | ((err: Error | undefined, data: Buffer) => void), maybeCallback?: (err: Error | undefined, data: Buffer) => void): void {
        this.readFileCalls.push(path)
        const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback!
        if (this.missing.has(path)) {
            callback(new Error("No such file"), Buffer.alloc(0))
            return
        }
        callback(undefined, Buffer.from(this.files.get(path) ?? ""))
    }

    writeFile(path: string, data: string | Buffer, callback: (err: Error | undefined) => void): void {
        const text = typeof data === "string" ? data : data.toString("utf8")
        this.writeFileCalls.push({ path, data: text })
        this.files.set(path, text)
        callback(undefined)
    }

    rename(oldPath: string, newPath: string, callback: (err: Error | undefined) => void): void {
        this.renameCalls.push({ oldPath, newPath })
        const data = this.files.get(oldPath)
        if (data === undefined) {
            callback(new Error("No such file"))
            return
        }
        this.files.delete(oldPath)
        this.files.set(newPath, data)
        callback(undefined)
    }

    unlink(path: string, callback: (err: Error | undefined) => void): void {
        this.unlinkCalls.push(path)
        this.files.delete(path)
        callback(undefined)
    }

    stat(_path: string, callback: (err: Error | undefined, stats: Stats) => void): void {
        callback(undefined, {} as Stats)
    }

    mkdir(_path: string, callback: (err: Error | undefined) => void): void {
        callback(undefined)
    }

    readdir(_path: string, callback: (err: Error | undefined, list: FileEntryWithStats[]) => void): void {
        callback(undefined, [])
    }
}

class FakeClient extends EventEmitter implements SshClientLike {
    constructor(private readonly sftpInstance: SftpLike) {
        super()
    }

    connect(_config: ConnectConfig): void {
    }

    exec(_command: string, _callback: (err: Error | undefined, channel: SshChannelLike) => void): void {
    }

    sftp(callback: (err: Error | undefined, sftp: SftpLike) => void): void {
        callback(undefined, this.sftpInstance)
    }

    end(): void {
    }
}

function createFakePool(client: SshClientLike): { configs: SshResolvedConfig[]; pool: SshConnectionPool } {
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

function buildDeps(sftp: MemorySftp) {
    return { env: envWithPassword, pool: createFakePool(new FakeClient(sftp)).pool }
}

function stored(sftp: MemorySftp, path: string): unknown {
    return JSON.parse(sftp.files.get(path) ?? "null")
}

function parseOut(result: unknown): any {
    const raw = typeof result === "string" ? result : (result as { output: string }).output
    return JSON.parse(raw)
}

describe("ssh config remove tool", () => {
    test("removes leaf key, writes file atomically, returns parent state", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": JSON.stringify({ server: { host: "h", port: 8080 }, debug: true }) })
        const tool = createAutocodeSshConfigRemoveTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", path: "/etc/app.json", key_path: "server.port" }, createToolContext())
        const out = parseOut(result)
        expect(out.removed).toEqual(["server", "port"])
        expect(out.parent_now).toEqual({ server: "{1 keys}" })
        expect(stored(sftp, "/etc/app.json")).toEqual({ server: { host: "h" }, debug: true })
        expect(sftp.renameCalls).toHaveLength(1)
    })

    test("refuses to remove root key and leaves file unchanged", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": JSON.stringify({ a: 1 }) })
        const tool = createAutocodeSshConfigRemoveTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", path: "/etc/app.json", key_path: [] }, createToolContext())
        const out = parseOut(result)
        expect(out.error).toContain("cannot remove root")
        expect(stored(sftp, "/etc/app.json")).toEqual({ a: 1 })
        expect(sftp.writeFileCalls).toHaveLength(0)
    })

    test("errors when key_path not found", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": JSON.stringify({ a: 1 }) })
        const tool = createAutocodeSshConfigRemoveTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", path: "/etc/app.json", key_path: "ghost" }, createToolContext())
        const out = parseOut(result)
        expect(out.error).toContain("key_path not found")
        expect(sftp.writeFileCalls).toHaveLength(0)
    })

    test("refuses markdown files", async () => {
        const sftp = new MemorySftp({ "/etc/README.md": "# hi" })
        const tool = createAutocodeSshConfigRemoveTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", path: "/etc/README.md", key_path: "x" }, createToolContext())
        const out = parseOut(result)
        expect(out.error).toContain("markdown")
    })

    test("returns error for unknown ssh_key", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": "{}" })
        const tool = createAutocodeSshConfigRemoveTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "missing", path: "/etc/app.json", key_path: "a" }, createToolContext())
        const out = parseOut(result)
        expect(out.failedAction).toBe("resolve SSH config")
    })

    test("wires ssh_key and remaps path to file_path", async () => {
        const sftp = new MemorySftp()
        const { configs, pool } = createFakePool(new FakeClient(sftp))
        const seen: Array<Record<string, unknown>> = []
        const execute = createRemoteConfigExecute({ env: envWithPassword, pool }, "remove SSH config file key", async (_adapter, args) => {
            seen.push(args)
            return "R"
        })
        await execute({ ssh_key: "dev", path: "/etc/app.json", key_path: "a" })
        expect(configs[0].key).toBe("dev")
        expect(seen[0].file_path).toBe("/etc/app.json")
    })
})
