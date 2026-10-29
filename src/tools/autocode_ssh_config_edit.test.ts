import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import type { ConnectConfig, FileEntryWithStats, Stats } from "ssh2"
import type { CredentialKind, CredentialResolver, ResolvedCredentialProfile, SshCredentialProfile } from "../credentials/types"
import type { SftpLike, SshChannelLike, SshClientLike, SshConnectionPool, SshResolvedConfig } from "../utils/ssh"
import { resetRetryCounts } from "../utils/tools"
import { createToolContext } from "./test_context"
import { createRemoteConfigAdapter, createRemoteConfigExecute } from "./config/ssh/adapter"
import { createAutocodeSshConfigEditTool } from "./autocode_ssh_config_edit"

const profileWithPassword = {
    host: "ssh.example:2200",
    username: "devuser",
    password: "secret",
} satisfies SshCredentialProfile

class FakeCredentialResolver implements CredentialResolver {
    readonly calls: Array<{ kind: CredentialKind; id: string }> = []

    constructor(private readonly profile: SshCredentialProfile = profileWithPassword) {
    }

    async resolve<K extends CredentialKind>(kind: K, id: string): Promise<ResolvedCredentialProfile<K>> {
        this.calls.push({ kind, id })
        if (kind !== "ssh") throw new Error("Expected SSH credentials")
        if (id !== "DEV") throw new Error("Unknown SSH profile")
        return { kind: "ssh", provider: "plaintext", profile: this.profile } as ResolvedCredentialProfile<K>
    }
}

class MemorySftp implements SftpLike {
    readonly files = new Map<string, string>()
    readonly readFileCalls: string[] = []
    readonly writeFileCalls: Array<{ path: string; data: string }> = []
    readonly renameCalls: Array<{ oldPath: string; newPath: string }> = []
    readonly unlinkCalls: string[] = []
    readonly missing = new Set<string>()
    readError?: unknown

    constructor(initial: Record<string, string> = {}) {
        for (const [key, value] of Object.entries(initial)) this.files.set(key, value)
    }

    readFile(path: string, callback: (err: Error | undefined, data: Buffer) => void): void
    readFile(path: string, encoding: BufferEncoding, callback: (err: Error | undefined, data: Buffer) => void): void
    readFile(path: string, encodingOrCallback: BufferEncoding | ((err: Error | undefined, data: Buffer) => void), maybeCallback?: (err: Error | undefined, data: Buffer) => void): void {
        this.readFileCalls.push(path)
        const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback
        if (!callback) throw new Error("Expected read callback")
        if (this.readError !== undefined) {
            // Malformed remote-config read payload exercises the real callback boundary.
            callback(this.readError as Error, Buffer.alloc(0))
            return
        }
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
    readonly connectConfigs: ConnectConfig[] = []

    constructor(private readonly sftpInstance: SftpLike) {
        super()
    }

    connect(config: ConnectConfig): void {
        this.connectConfigs.push(config)
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

function buildDeps(sftp: MemorySftp, profile: SshCredentialProfile = profileWithPassword): { credentialResolver: FakeCredentialResolver; configs: SshResolvedConfig[]; pool: SshConnectionPool; client: FakeClient } {
    const client = new FakeClient(sftp)
    return { credentialResolver: new FakeCredentialResolver(profile), ...createFakePool(client), client }
}

function stored(sftp: MemorySftp, path: string): unknown {
    return JSON.parse(sftp.files.get(path) ?? "null")
}

function parseOut(result: unknown) {
    const raw = typeof result === "string" ? result : (result as { output: string }).output
    return JSON.parse(raw)
}

describe("ssh config edit adapter", () => {
    test("edit uses atomic temp-file-then-rename", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": '{"a":1}' })
        const adapter = createRemoteConfigAdapter(sftp)
        await adapter.write({ absolutePath: "/etc/app.json", mode: "json" }, '{"a":2,"b":3}')
        expect(sftp.files.get("/etc/app.json")).toBe('{"a":2,"b":3}')
        expect(sftp.renameCalls).toHaveLength(1)
        expect(sftp.renameCalls[0].newPath).toBe("/etc/app.json")
        expect(sftp.renameCalls[0].oldPath).toMatch(/^\/etc\/\.app\.json\.\d+-[a-z0-9]+\.tmp$/)
        const tempPath = sftp.renameCalls[0].oldPath
        expect(sftp.writeFileCalls.map((w) => w.path)).toContain(tempPath)
        expect(sftp.writeFileCalls.find((w) => w.path === tempPath)?.data).toBe('{"a":2,"b":3}')
    })
})

describe("ssh config edit tool", () => {
    test("REPLACE over SFTP updates file atomically", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": JSON.stringify({ port: 8080 }) })
        const deps = buildDeps(sftp)
        const tool = createAutocodeSshConfigEditTool(deps)
        const result = await tool.execute({ ssh_key: "dev", path: "/etc/app.json", current_key: "port", content: "9090" }, createToolContext())
        const out = parseOut(result)
        expect(out.action).toBe("replace")
        expect(stored(sftp, "/etc/app.json")).toEqual({ port: 9090 })
        expect(sftp.renameCalls).toHaveLength(1)
        expect(deps.credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
        expect(deps.configs).toHaveLength(1)
        expect(deps.configs[0]).toMatchObject({
            host: "ssh.example", port: 2200, username: "devuser", auth: { method: "password", password: "secret" },
            connectConfig: { host: "ssh.example", port: 2200, username: "devuser", password: "secret" },
        })
    })

    test("CREATE over SFTP adds new key", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": JSON.stringify({ port: 8080 }) })
        const tool = createAutocodeSshConfigEditTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", path: "/etc/app.json", new_key: "host", content: '"localhost"' }, createToolContext())
        const out = parseOut(result)
        expect(out.action).toBe("create")
        expect(stored(sftp, "/etc/app.json")).toEqual({ port: 8080, host: "localhost" })
    })

    test("RENAME over SFTP moves key", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": JSON.stringify({ port: 8080 }) })
        const tool = createAutocodeSshConfigEditTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", path: "/etc/app.json", current_key: "port", new_key: "listen" }, createToolContext())
        const out = parseOut(result)
        expect(out.action).toBe("rename")
        expect(stored(sftp, "/etc/app.json")).toEqual({ listen: 8080 })
    })

    test("errors when new_key already exists and leaves file unchanged", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": JSON.stringify({ a: 1, b: 2 }) })
        const tool = createAutocodeSshConfigEditTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", path: "/etc/app.json", current_key: "a", new_key: "b" }, createToolContext())
        const out = parseOut(result)
        expect(out.error).toContain("new_key already exists")
        expect(stored(sftp, "/etc/app.json")).toEqual({ a: 1, b: 2 })
        expect(sftp.writeFileCalls).toHaveLength(0)
    })

    test("errors when current_key not found", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": JSON.stringify({ a: 1 }) })
        const tool = createAutocodeSshConfigEditTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", path: "/etc/app.json", current_key: "ghost", content: "5" }, createToolContext())
        const out = parseOut(result)
        expect(out.error).toContain("current_key not found")
        expect(sftp.writeFileCalls).toHaveLength(0)
    })

    test("errors when content required for replace", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": JSON.stringify({ a: 1 }) })
        const tool = createAutocodeSshConfigEditTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", path: "/etc/app.json", current_key: "a" }, createToolContext())
        const out = parseOut(result)
        expect(out.error).toContain("content required")
        expect(sftp.writeFileCalls).toHaveLength(0)
    })

    test("refuses markdown files", async () => {
        const sftp = new MemorySftp({ "/etc/README.md": "# hi" })
        const tool = createAutocodeSshConfigEditTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", path: "/etc/README.md", current_key: "a", content: "1" }, createToolContext())
        const out = parseOut(result)
        expect(out.error).toContain("markdown")
    })

    test("returns error for unknown ssh_key", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": "{}" })
        const deps = buildDeps(sftp)
        const tool = createAutocodeSshConfigEditTool(deps)
        const result = await tool.execute({ ssh_key: "missing", path: "/etc/app.json", current_key: "a", content: "1" }, createToolContext())
        const out = parseOut(result)
        expect(out.failedAction).toBe("resolve SSH config")
        expect(out.error).toBe("SSH credential resolution failed")
        expect(Object.keys(out)).toEqual(["failedAction", "error", "instruction"])
        expect(out.instruction.trim().length).toBeGreaterThan(0)
        expect(deps.credentialResolver.calls).toEqual([{ kind: "ssh", id: "MISSING" }])
        expect(deps.configs).toEqual([])
        expect(deps.client.connectConfigs).toEqual([])
        expect(sftp.readFileCalls).toEqual([])
    })

    test("wires ssh_key and remaps path to file_path", async () => {
        const sftp = new MemorySftp()
        const { configs, pool } = createFakePool(new FakeClient(sftp))
        const credentialResolver = new FakeCredentialResolver()
        const seen: Array<Record<string, unknown>> = []
        const execute = createRemoteConfigExecute({ credentialResolver, pool }, "write SSH config file", async (_adapter, args) => {
            seen.push(args)
            return "W"
        })
        await execute({ ssh_key: "dev", path: "/etc/app.json", current_key: "a", content: "1" })
        expect(configs[0].key).toBe("dev")
        expect(configs).toHaveLength(1)
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
        expect(seen[0].file_path).toBe("/etc/app.json")
    })

    test("SFTP read failure never exposes credentials through config flow errors", async () => {
        const directory = await mkdtemp(join(tmpdir(), "autocode-ssh-"))
        try {
            const markers = { password: "edit-password-marker", keypass: "edit-keypass-marker", privateKey: "edit-private-key-marker" }
            const keyfile = join(directory, "id_ed25519")
            await writeFile(keyfile, markers.privateKey)
            const sftp = new MemorySftp({ "/etc/app.json": '{"port":8080}' })
            sftp.readError = new Error(`opaque read failure ${Object.values(markers).join(" ")}`)
            const deps = buildDeps(sftp, { ...profileWithPassword, password: markers.password, keypass: markers.keypass, keyfile })
            const result = await createAutocodeSshConfigEditTool(deps).execute({ ssh_key: "dev", path: "/etc/app.json", current_key: "port", content: "9090" }, createToolContext())

            expect(typeof result).toBe("string")
            const out = parseOut(result)
            expect(Object.keys(out)).toEqual(["failedAction", "error", "instruction"])
            expect(out).toEqual({ failedAction: "Write configuration file", error: "SSH operation failed", instruction: expect.any(String) })
            expect(out.instruction.trim().length).toBeGreaterThan(0)
            for (const marker of Object.values(markers)) expect(result as string).not.toContain(marker)
            expect(deps.credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
            expect(deps.configs).toHaveLength(1)
            expect(deps.configs[0].connectConfig).toMatchObject({ privateKey: markers.privateKey, passphrase: markers.keypass, password: markers.password })
            expect(sftp.writeFileCalls).toEqual([])
        }
        finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    test.each(["string", "object"] as const)("serialized config edit read %s failure never evaluates hostile payloads", async (form) => {
        const directory = await mkdtemp(join(tmpdir(), "autocode-ssh-"))
        resetRetryCounts()

        try {
            const markers = { password: "serialized-edit-password-marker", keypass: "serialized-edit-keypass-marker", privateKey: "serialized-edit-private-key-marker" }
            const failure = `opaque read failure ${Object.values(markers).join(" ")}`
            const counters = { message: 0, custom: 0, cause: 0, toJSON: 0, toString: 0, toPrimitive: 0 }
            const hostile = {
                get message(): string {
                    counters.message += 1
                    return failure
                },
                get custom(): string {
                    counters.custom += 1
                    return failure
                },
                get cause(): string {
                    counters.cause += 1
                    return failure
                },
                toJSON(): string {
                    counters.toJSON += 1
                    return failure
                },
                toString(): string {
                    counters.toString += 1
                    return failure
                },
                [Symbol.toPrimitive](): string {
                    counters.toPrimitive += 1
                    return failure
                },
            }
            const keyfile = join(directory, "id_ed25519")
            await writeFile(keyfile, markers.privateKey)
            const sftp = new MemorySftp({ "/etc/app.json": '{"port":8080}' })
            sftp.readError = form === "string" ? failure : hostile
            const deps = buildDeps(sftp, { ...profileWithPassword, password: markers.password, keypass: markers.keypass, keyfile })
            const result = await createAutocodeSshConfigEditTool(deps).execute({ ssh_key: "dev", path: "/etc/app.json", current_key: "port", content: "9090" }, createToolContext())

            expect(typeof result).toBe("string")
            const out = JSON.parse(result as string) as Record<string, unknown>
            expect(Object.keys(out)).toEqual(["failedAction", "error", "instruction"])
            expect(out).toEqual({ failedAction: "Write configuration file", error: "SSH operation failed", instruction: "Ensure the file exists and is readable." })
            for (const marker of Object.values(markers)) expect(result as string).not.toContain(marker)
            expect(counters).toEqual({ message: 0, custom: 0, cause: 0, toJSON: 0, toString: 0, toPrimitive: 0 })
            expect(deps.credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
            expect(deps.configs).toHaveLength(1)
            expect(deps.configs[0].connectConfig).toMatchObject({ password: markers.password, passphrase: markers.keypass, privateKey: markers.privateKey })
            expect(sftp.readFileCalls).toEqual(["/etc/app.json"])
            expect(sftp.writeFileCalls).toEqual([])
        }
        finally {
            resetRetryCounts()
            await rm(directory, { recursive: true, force: true })
        }
    })
})
