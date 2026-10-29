import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import type { ConnectConfig, FileEntryWithStats, Stats } from "ssh2"
import type { CredentialKind, CredentialResolver, ResolvedCredentialProfile, SshCredentialProfile } from "../credentials/types"
import { sftpMkdir, sftpReadFile, sftpStat, SshConnectionPool } from "../utils/ssh"
import { createRetryResponse, resetRetryCounts } from "../utils/tools"
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
    statIfExists,
    withSftp,
} from "./autocode_ssh"
import type { SftpLike, SshChannelLike, SshClientLike, SshReadableLike, SshResolvedConfig } from "../utils/ssh"

type CommandOutput = { stdout?: string; stderr?: string; exitCode?: number }
type SshToolErrorResponse = { failedAction?: unknown; error?: unknown; instruction?: unknown }

const profileWithPassword = {
    host: "ssh.example:2200",
    username: "devuser",
    password: "secret",
} satisfies SshCredentialProfile
const temporaryRoot = tmpdir()
const temporaryDirectories: string[] = []
const secretMarkers = {
    password: "password-fixture-marker",
    keypass: "keypass-fixture-marker",
    privateKey: "private-key-fixture-marker",
}
const credentialFailure = `opaque failure ${Object.values(secretMarkers).join(" ")}`
const patchFailureDiagnostic = "SSH patch could not be applied"

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

class FakeCredentialResolver implements CredentialResolver {
    readonly calls: Array<{ kind: CredentialKind; id: string }> = []
    error?: unknown

    constructor(private readonly profile: SshCredentialProfile = profileWithPassword, private readonly id = "DEV") {
    }

    async resolve<K extends CredentialKind>(kind: K, id: string): Promise<ResolvedCredentialProfile<K>> {
        this.calls.push({ kind, id })
        if (kind !== "ssh") throw new Error("Expected SSH credentials")
        if (this.error !== undefined) throw this.error
        if (id !== this.id) throw new Error("Unknown SSH profile")
        return { kind: "ssh", provider: "plaintext", profile: this.profile } as ResolvedCredentialProfile<K>
    }
}

async function createKeyFile(content = "real-key"): Promise<string> {
    const directory = await mkdtemp(join(temporaryRoot, "autocode-ssh-"))
    temporaryDirectories.push(directory)
    const keyPath = join(directory, "id_ed25519")
    await writeFile(keyPath, content)
    return keyPath
}

async function withCredentialEnvTrap(operation: (accesses: string[]) => Promise<void>): Promise<void> {
    const originalEnv = process.env
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, "env")
    const accesses: string[] = []
    const emptyEnv: NodeJS.ProcessEnv = {}
    const trappedEnv = new Proxy(emptyEnv, {
        get(_target, key): undefined {
            if (typeof key === "string" && key.startsWith("AUTOCODE_SSH_")) accesses.push(key)
            return undefined
        },
        has(_target, key): boolean {
            if (typeof key === "string" && key.startsWith("AUTOCODE_SSH_")) accesses.push(key)
            return false
        },
    })

    try {
        Object.defineProperty(process, "env", { configurable: true, enumerable: true, writable: true, value: trappedEnv })
        void process.env.AUTOCODE_SSH_READ_TRAP_PROBE
        expect(accesses).toEqual(["AUTOCODE_SSH_READ_TRAP_PROBE"])
        expect("AUTOCODE_SSH_READ_TRAP_PROBE" in process.env).toBe(false)
        expect(accesses).toEqual(["AUTOCODE_SSH_READ_TRAP_PROBE", "AUTOCODE_SSH_READ_TRAP_PROBE"])
        accesses.length = 0
        await operation(accesses)
    }
    finally {
        Object.defineProperty(process, "env", originalDescriptor ?? { configurable: true, enumerable: true, writable: true, value: originalEnv })
    }
}

function createHostileFailure(): { payload: object; counters: Record<string, number> } {
    const counters = { message: 0, password: 0, keypass: 0, privateKey: 0, cause: 0, toJSON: 0, toString: 0, toPrimitive: 0 }
    const payload = {
        get message(): string {
            counters.message += 1
            return credentialFailure
        },
        get password(): string {
            counters.password += 1
            return secretMarkers.password
        },
        get keypass(): string {
            counters.keypass += 1
            return secretMarkers.keypass
        },
        get privateKey(): string {
            counters.privateKey += 1
            return secretMarkers.privateKey
        },
        get cause(): string {
            counters.cause += 1
            return credentialFailure
        },
        toJSON(): string {
            counters.toJSON += 1
            return credentialFailure
        },
        toString(): string {
            counters.toString += 1
            return credentialFailure
        },
        [Symbol.toPrimitive](): string {
            counters.toPrimitive += 1
            return credentialFailure
        },
    }
    return { payload, counters }
}

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

function expectSafeSshError(result: unknown, failedAction: string, errorText: string): void {
    const parsed = expectJsonString<SshToolErrorResponse>(result)
    expect(Object.keys(parsed)).toEqual(["failedAction", "error", "instruction"])
    expect(parsed).toEqual({ failedAction, error: errorText, instruction: expect.any(String) })
    expect((parsed.instruction as string).trim().length).toBeGreaterThan(0)
    for (const marker of Object.values(secretMarkers)) expect(result as string).not.toContain(marker)
}

class FakeReadable extends EventEmitter implements SshReadableLike {
}

class FakeChannel extends FakeReadable implements SshChannelLike {
    readonly stderr = new FakeReadable()
}

class FakeClient extends EventEmitter implements SshClientLike {
    readonly commands: string[] = []
    readonly connectConfigs: ConnectConfig[] = []
    sftpCalls = 0
    connectError?: unknown
    execError?: unknown
    sftpError?: unknown

    constructor(private readonly sftpInstance: SftpLike, private readonly outputForCommand: (command: string) => CommandOutput = () => ({ stdout: "" })) {
        super()
    }

    connect(config: ConnectConfig): void {
        this.connectConfigs.push(config)
        queueMicrotask(() => {
            if (this.connectError !== undefined) this.emit("error", this.connectError)
            else this.emit("ready")
        })
    }

    exec(command: string, callback: (err: Error | undefined, channel: SshChannelLike) => void): void {
        this.commands.push(command)
        const channel = new FakeChannel()
        if (this.execError !== undefined) {
            // Malformed exec callback payload exercises runtime error handling.
            callback(this.execError as Error, channel)
            return
        }
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
        this.sftpCalls += 1
        if (this.sftpError !== undefined) {
            // Malformed SFTP acquisition payload must reach production unchanged.
            callback(this.sftpError as Error, this.sftpInstance)
            return
        }
        callback(undefined, this.sftpInstance)
    }

    end(): void {
    }
}

class FakeSftp implements SftpLike {
    readonly writes: Array<{ path: string; data: string }> = []
    readonly mkdirs: string[] = []
    readonly readFileCalls: string[] = []
    readonly readReceivers: SftpLike[] = []
    readonly readEncodings: Array<BufferEncoding | undefined> = []
    readonly statCalls: string[] = []
    readonly readdirCalls: string[] = []
    readData?: Buffer | string
    readError?: unknown
    readThrow?: unknown
    statError?: Error
    mkdirError?: Error
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
        this.readReceivers.push(this)
        this.readEncodings.push(typeof encodingOrCallback === "function" ? undefined : encodingOrCallback)
        if (this.readThrow !== undefined) throw this.readThrow
        const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback
        if (this.readError !== undefined) {
            // Malformed SFTP read payload deliberately bypasses static Error typing.
            callback?.(this.readError as Error, Buffer.alloc(0))
            return
        }
        if (this.missingPaths.has(path)) {
            callback?.(createMissingRemoteError(), Buffer.from(""))
            return
        }
        const data = this.readData ?? Buffer.from(this.files[path] ?? "")
        if (typeof encodingOrCallback === "function") encodingOrCallback(undefined, Buffer.isBuffer(data) ? data : Buffer.from(data))
        else {
            // Preserve encoded string transport data despite the callback's Buffer-only type.
            maybeCallback?.(undefined, typeof data === "string" ? data as unknown as Buffer : data)
        }
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
        this.statCalls.push(path)
        if (this.statError) {
            callback(this.statError, createStats())
            return
        }
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
        if (this.mkdirError) {
            callback(this.mkdirError)
            return
        }
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

function createFakePool(client: FakeClient, error?: Error): { configs: SshResolvedConfig[]; pool: SshConnectionPool } {
    const configs: SshResolvedConfig[] = []
    const pool = {
        async get(config: SshResolvedConfig): Promise<SshClientLike> {
            configs.push(config)
            if (error) throw error
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
    test("command resolves one normalized SSH profile and reports untruncated output", async () => {
        const client = new FakeClient(new FakeSftp(), () => ({ stdout: "ok\n", stderr: "warn\n" }))
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver(profileWithPassword, "DEV_WEST")
        const tool = createAutocodeSshCommandTool({ credentialResolver, pool })

        const result = await tool.execute({ ssh_key: " dev-West ", command: "uptime", max_characters: 20 }, createToolContext())
        const payload = parseToolResult(result)

        expect(Object.keys(payload)).toEqual(["host", "port", "output", "output_truncated"])
        expect(payload).toEqual({ host: "ssh.example", port: 2200, output: "ok\nwarn\n", output_truncated: false })
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV_WEST" }])
        expect(configs).toHaveLength(1)
        expect(configs[0]).toMatchObject({
            host: "ssh.example",
            port: 2200,
            username: "devuser",
            auth: { method: "password", password: "secret" },
            connectConfig: { host: "ssh.example", port: 2200, username: "devuser", password: "secret" },
        })
        expect(client.commands).toEqual(["uptime"])
    })

    test("command uses profile port override instead of host port", async () => {
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver({ ...profileWithPassword, port: "49596" })
        const tool = createAutocodeSshCommandTool({ credentialResolver, pool })

        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", command: "uptime" }, createToolContext()))

        expect(payload.port).toBe(49596)
        expect(configs[0].port).toBe(49596)
        expect(configs[0].connectConfig.port).toBe(49596)
        expect(configs[0].connectConfig.host).toBe("ssh.example")
        expect(configs).toHaveLength(1)
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
    })

    test.each([
        ["0", "SSH port must be between 1 and 65535"],
        ["65536", "SSH port must be between 1 and 65535"],
        ["-1", "SSH port must be an integer"],
        ["1.5", "SSH port must be an integer"],
        ["invalid", "SSH port must be an integer"],
        [" ", "SSH port must be an integer"],
    ])("command rejects invalid profile port %s without connecting", async (port, diagnostic) => {
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver({ ...profileWithPassword, port })
        const tool = createAutocodeSshCommandTool({ credentialResolver, pool })

        const result = await tool.execute({ ssh_key: "dev", command: "uptime" }, createToolContext())

        expectSafeSshError(result, "resolve SSH config", diagnostic)
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
        expect(configs).toEqual([])
        expect(client.connectConfigs).toEqual([])
        expect(client.commands).toEqual([])
    })

    test.each(["1", "65535"])("command accepts profile port boundary %s", async (port) => {
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver({ ...profileWithPassword, port })
        const result = await createAutocodeSshCommandTool({ credentialResolver, pool }).execute({ ssh_key: "dev", command: "uptime" }, createToolContext())

        expect(parseToolResult(result).port).toBe(Number(port))
        expect(configs).toHaveLength(1)
        expect(configs[0].connectConfig.port).toBe(Number(port))
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
    })

    test("command truncates by max_characters", async () => {
        const client = new FakeClient(new FakeSftp(), () => ({ stdout: "line1\nline2\nline3" }))
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshCommandTool({ credentialResolver: new FakeCredentialResolver(), pool })

        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", command: "cat log", max_characters: 6 }, createToolContext()))

        expect(payload.output).toBe("line3")
        expect(payload.output_truncated).toBe(true)
    })

    test("command uses keypass as passphrase for readable keyfile", async () => {
        const keyPath = await createKeyFile()
        const readPaths: string[] = []
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver({ ...profileWithPassword, keyfile: keyPath, keypass: "key-secret", agent: "fake-agent" })
        const tool = createAutocodeSshCommandTool({
            credentialResolver,
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
        expect(configs[0].connectConfig.passphrase).toBe("key-secret")
        expect(configs[0].connectConfig.password).toBe("secret")
        expect(configs[0].connectConfig.agent).toBeUndefined()
        expect(configs).toHaveLength(1)
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
    })

    test("command uses readable keyfile without passphrase when password is missing", async () => {
        const keyPath = await createKeyFile()
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver({ host: "ssh.example", keyfile: keyPath })
        const tool = createAutocodeSshCommandTool({
            credentialResolver,
            fs: {
                readFile(): string {
                    return "fake-key"
                },
            },
            pool,
        })

        await tool.execute({ ssh_key: "dev", command: "whoami" }, createToolContext())

        expect(configs[0].auth.method).toBe("privateKey")
        expect(configs[0].connectConfig.privateKey).toBe("fake-key")
        expect(configs[0].connectConfig.passphrase).toBeUndefined()
        expect(configs[0].connectConfig.password).toBeUndefined()
        expect(configs).toHaveLength(1)
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
    })

    test("command does not use password as passphrase for readable keyfile", async () => {
        const keyPath = await createKeyFile()
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver({ ...profileWithPassword, keyfile: keyPath })
        const tool = createAutocodeSshCommandTool({
            credentialResolver,
            fs: {
                readFile(): string {
                    return "fake-key"
                },
            },
            pool,
        })

        await tool.execute({ ssh_key: "dev", command: "whoami" }, createToolContext())

        expect(configs[0].auth.method).toBe("privateKey")
        expect(configs[0].connectConfig.privateKey).toBe("fake-key")
        expect(configs[0].connectConfig.passphrase).toBeUndefined()
        expect(configs[0].connectConfig.password).toBe("secret")
        expect(configs).toHaveLength(1)
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
    })

    test("command ignores blank keypass for readable keyfile", async () => {
        const keyPath = await createKeyFile()
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver({ host: "ssh.example", keyfile: keyPath, keypass: "" })
        const tool = createAutocodeSshCommandTool({
            credentialResolver,
            fs: {
                readFile(): string {
                    return "fake-key"
                },
            },
            pool,
        })

        await tool.execute({ ssh_key: "dev", command: "whoami" }, createToolContext())

        expect(configs[0].auth.method).toBe("privateKey")
        expect(configs[0].connectConfig.passphrase).toBeUndefined()
        expect(configs[0].connectConfig.password).toBeUndefined()
        expect(configs).toHaveLength(1)
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
    })

    test("command falls back to password for nonexistent keyfile", async () => {
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver({ ...profileWithPassword, keyfile: join(temporaryRoot, "missing-autocode-key"), agent: "fake-agent" })
        const tool = createAutocodeSshCommandTool({ credentialResolver, pool })

        await tool.execute({ ssh_key: "dev", command: "whoami" }, createToolContext())

        expect(configs[0].auth.method).toBe("password")
        expect(configs[0].connectConfig.password).toBe("secret")
        expect(configs[0].connectConfig.privateKey).toBeUndefined()
        expect(configs[0].connectConfig.agent).toBeUndefined()
        expect(configs).toHaveLength(1)
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
    })

    test.each([
        { name: "password wins over agent", profile: { ...profileWithPassword, agent: "fake-agent" }, method: "password", password: "secret", agent: undefined },
        { name: "agent-only profile", profile: { host: "ssh.example", agent: "fake-agent" }, method: "agent", password: undefined, agent: "fake-agent" },
        { name: "missing keyfile falls back to agent", profile: { host: "ssh.example", keyfile: join(temporaryRoot, "missing-autocode-key"), agent: "fake-agent" }, method: "agent", password: undefined, agent: "fake-agent" },
    ])("command authenticates with $name", async ({ profile, method, password, agent }) => {
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver(profile)
        const result = await createAutocodeSshCommandTool({ credentialResolver, pool }).execute({ ssh_key: "dev", command: "whoami" }, createToolContext())

        expect(parseToolResult(result).host).toBe("ssh.example")
        expect(configs).toHaveLength(1)
        expect(configs[0].auth.method).toBe(method)
        expect(configs[0].connectConfig.password).toBe(password)
        expect(configs[0].connectConfig.agent).toBe(agent)
        expect(configs[0].connectConfig.privateKey).toBeUndefined()
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
    })

    test.each(["password", "agent"] as const)("command falls back to %s when keyfile read fails", async (method) => {
        const keyfile = await createKeyFile()
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver({
            host: "ssh.example",
            keyfile,
            keypass: secretMarkers.keypass,
            password: method === "password" ? secretMarkers.password : undefined,
            agent: "fake-agent",
        })
        const readPaths: string[] = []
        const tool = createAutocodeSshCommandTool({
            credentialResolver,
            pool,
            fs: {
                readFile(path: string): string {
                    readPaths.push(path)
                    throw new Error(credentialFailure)
                },
            },
        })
        const result = await tool.execute({ ssh_key: "dev", command: "whoami" }, createToolContext())

        expect(parseToolResult(result).host).toBe("ssh.example")
        expect(readPaths).toEqual([keyfile])
        expect(configs).toHaveLength(1)
        expect(configs[0].auth.method).toBe(method)
        expect(configs[0].connectConfig.password).toBe(method === "password" ? secretMarkers.password : undefined)
        expect(configs[0].connectConfig.agent).toBe(method === "agent" ? "fake-agent" : undefined)
        expect(configs[0].connectConfig.privateKey).toBeUndefined()
        expect(configs[0].connectConfig.passphrase).toBeUndefined()
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
    })

    test("command defaults username to root and allows no explicit auth", async () => {
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver({ host: "mail26.example", keyfile: join(temporaryRoot, "missing-autocode-key") }, "MAIL26")
        const tool = createAutocodeSshCommandTool({ credentialResolver, pool })

        await tool.execute({ ssh_key: "MAIL26", command: "whoami" }, createToolContext())

        expect(configs[0].username).toBe("root")
        expect(configs[0].auth).toEqual({ method: "none" })
        expect(configs[0].connectConfig).toMatchObject({ host: "mail26.example", port: 22, username: "root" })
        expect(configs[0].connectConfig.password).toBeUndefined()
        expect(configs[0].connectConfig.privateKey).toBeUndefined()
        expect(configs[0].connectConfig.agent).toBeUndefined()
        expect(configs).toHaveLength(1)
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "MAIL26" }])
    })

    test("resolver rejection returns a safe error without fallback or connection", async () => {
        const keyfile = await createKeyFile(secretMarkers.privateKey)
        const credentialResolver = new FakeCredentialResolver({ ...profileWithPassword, password: secretMarkers.password, keypass: secretMarkers.keypass, keyfile })
        credentialResolver.error = new Error(credentialFailure)
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const readPaths: string[] = []
        const result = await createAutocodeSshCommandTool({
            credentialResolver,
            pool,
            fs: {
                readFile(path: string): string {
                    readPaths.push(path)
                    return secretMarkers.privateKey
                },
            },
        }).execute({ ssh_key: "dev", command: "whoami" }, createToolContext())

        expectSafeSshError(result, "resolve SSH config", "SSH credential resolution failed")
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
        expect(configs).toEqual([])
        expect(client.connectConfigs).toEqual([])
        expect(client.commands).toEqual([])
        expect(readPaths).toEqual([])
    })

    test.each([
        { name: "missing host", profile: { password: secretMarkers.password } as SshCredentialProfile, diagnostic: "SSH host is required" },
        { name: "empty host", profile: { host: "", password: secretMarkers.password }, diagnostic: "SSH host is required" },
        { name: "blank host", profile: { host: " \t", password: secretMarkers.password }, diagnostic: "SSH host is required" },
        { name: "non-string host", profile: { host: 123, password: secretMarkers.password } as unknown as SshCredentialProfile, diagnostic: "SSH configuration could not be resolved" },
    ])("incomplete profile with $name never connects", async ({ profile, diagnostic }) => {
        const credentialResolver = new FakeCredentialResolver(profile)
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const result = await createAutocodeSshCommandTool({ credentialResolver, pool }).execute({ ssh_key: "dev", command: "whoami" }, createToolContext())

        expectSafeSshError(result, "resolve SSH config", diagnostic)
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
        expect(configs).toEqual([])
        expect(client.connectConfigs).toEqual([])
        expect(client.commands).toEqual([])
    })

    test.each(["pool", "connection", "exec", "sftp", "patch"] as const)("%s failure never exposes credential inputs", async (stage) => {
        const keyfile = await createKeyFile(secretMarkers.privateKey)
        const credentialResolver = new FakeCredentialResolver({
            ...profileWithPassword,
            password: secretMarkers.password,
            keypass: secretMarkers.keypass,
            keyfile,
            agent: "fake-agent",
        })
        const sftp = new FakeSftp({ "/srv/file.txt": "one\n" })
        const client = new FakeClient(sftp)
        const error = new Error(stage === "pool" ? `ECONNREFUSED ${credentialFailure}` : credentialFailure)
        if (stage === "connection") client.connectError = error
        if (stage === "exec") client.execError = error
        if (stage === "sftp") sftp.readError = error
        if (stage === "patch") sftp.writeError = error
        const { configs, pool: fakePool } = createFakePool(client, stage === "pool" ? error : undefined)
        const pool = stage === "connection" ? new SshConnectionPool({ clientFactory: () => client }) : fakePool
        const deps = { credentialResolver, pool }
        let result: unknown
        if (stage === "sftp") result = await createAutocodeSshReadFileTool(deps).execute({ ssh_key: "dev", path: "/srv/file.txt" }, createToolContext())
        else if (stage === "patch") result = await createAutocodeSshPatchFileTool(deps).execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "@@ -1,1 +1,1 @@\n-one\n+ONE\n" }, createToolContext())
        else result = await createAutocodeSshCommandTool(deps).execute({ ssh_key: "dev", command: "whoami" }, createToolContext())

        const failedAction = stage === "sftp" ? "read SSH file" : stage === "patch" ? "patch SSH file" : "execute SSH command"
        expectSafeSshError(result, failedAction, stage === "pool" ? "SSH connection refused" : "SSH operation failed")
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
        const connectConfig = stage === "connection" ? client.connectConfigs[0] : configs[0].connectConfig
        expect(connectConfig).toMatchObject({ privateKey: secretMarkers.privateKey, passphrase: secretMarkers.keypass, password: secretMarkers.password })
        if (stage === "connection") expect(client.connectConfigs).toHaveLength(1)
        else expect(configs).toHaveLength(1)
        expect(sftp.writes).toEqual([])
    })

    test("patch diagnostics never echo credential markers from malformed headers", async () => {
        const keyfile = await createKeyFile(secretMarkers.privateKey)
        const credentialResolver = new FakeCredentialResolver({ ...profileWithPassword, keyfile, password: secretMarkers.password, keypass: secretMarkers.keypass })
        const sftp = new FakeSftp({ "/srv/file.txt": "one\n" })
        const { configs, pool } = createFakePool(new FakeClient(sftp))
        const result = await createAutocodeSshPatchFileTool({ credentialResolver, pool }).execute({ ssh_key: "dev", path: "/srv/file.txt", patch: `@@ ${credentialFailure}\n-one\n+ONE\n` }, createToolContext())

        expectSafeSshError(result, "patch SSH file", "SSH patch could not be applied")
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
        expect(configs).toHaveLength(1)
        expect(sftp.writes).toEqual([])
    })

    test("list applies name, extension, and max filters with exact fields", async () => {
        const sftp = new FakeSftp({}, {}, { "/var/log": ["app.log", "app.txt", "db.log", "my-app.log"] }) as SftpLike
        const client = new FakeClient(sftp)
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshListTool({ credentialResolver: new FakeCredentialResolver(), pool })

        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", directory: "/var/log", name_filter: "app", ext_filter: "log", max_items: 1 }, createToolContext()))

        expect(Object.keys(payload)).toEqual(["host", "port", "list", "list_truncated"])
        expect(payload).toEqual({ host: "ssh.example", port: 2200, list: ["/var/log/app.log"], list_truncated: true })
    })

    test("read attributes parses stat fields with exact payload fields", async () => {
        const sftp = new FakeSftp({}, { "/srv/file.txt": createStats({ size: 1 }) }) as SftpLike
        const client = new FakeClient(sftp, createCommandOutput)
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshReadAttributesTool({ credentialResolver: new FakeCredentialResolver(), pool })

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
        const tool = createAutocodeSshWriteAttributesTool({ credentialResolver: new FakeCredentialResolver(), pool })

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
        const tool = createAutocodeSshReadFileTool({ credentialResolver: new FakeCredentialResolver(), pool })

        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/tmp/file.txt", first_line: 2, last_line: 3 }, createToolContext()))

        expect(Object.keys(payload)).toEqual(["host", "port", "path", "content", "content_truncated"])
        expect(payload).toEqual({ host: "ssh.example", port: 2200, path: "/tmp/file.txt", content: "two\nthree\n", content_truncated: false })
    })

    test("read_file truncates content at 4000 characters", async () => {
        const sftp = new FakeSftp({ "/tmp/large.txt": "x".repeat(4001) }) as SftpLike
        const client = new FakeClient(sftp)
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshReadFileTool({ credentialResolver: new FakeCredentialResolver(), pool })

        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/tmp/large.txt" }, createToolContext()))

        expect(String(payload.content).length).toBe(4000)
        expect(payload.content_truncated).toBe(true)
    })

    test("invalid bounds and missing config return shared error keys", async () => {
        const readFileTool = createAutocodeSshReadFileTool({ credentialResolver: new FakeCredentialResolver() })
        const invalidBounds = parseToolResult(await readFileTool.execute({ ssh_key: "dev", path: "/tmp/file", first_line: 3, last_line: 2 }, createToolContext()))
        const client = new FakeClient(new FakeSftp())
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver()
        const missingConfig = parseToolResult(await createAutocodeSshCommandTool({ credentialResolver, pool }).execute({ ssh_key: "missing", command: "ls" }, createToolContext()))

        expect(Object.keys(invalidBounds)).toEqual(["failedAction", "error", "instruction"])
        expect(Object.keys(missingConfig)).toEqual(["failedAction", "error", "instruction"])
        expect(missingConfig.error).toBe("SSH credential resolution failed")
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "MISSING" }])
        expect(configs).toEqual([])
        expect(client.connectConfigs).toEqual([])
    })

    test("read_file defaults last_line to 40", async () => {
        const file = `${Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n")}\n`
        const sftp = new FakeSftp({ "/tmp/many.txt": file }) as SftpLike
        const client = new FakeClient(sftp)
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshReadFileTool({ credentialResolver: new FakeCredentialResolver(), pool })
        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/tmp/many.txt" }, createToolContext()))
        const expected = `${Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n")}\n`
        expect(payload.content).toBe(expected)
        expect(payload.content_truncated).toBe(false)
    })

    test("read_file clamps last_line to total lines", async () => {
        const sftp = new FakeSftp({ "/tmp/short.txt": "a\nb\nc\nd\ne\n" }) as SftpLike
        const client = new FakeClient(sftp)
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshReadFileTool({ credentialResolver: new FakeCredentialResolver(), pool })
        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/tmp/short.txt", last_line: 100 }, createToolContext()))
        expect(payload.content).toBe("a\nb\nc\nd\ne\n")
        expect(payload.content_truncated).toBe(false)
    })

    test("read_file reads one line when first_line equals last_line", async () => {
        const sftp = new FakeSftp({ "/tmp/file.txt": "one\ntwo\nthree\nfour\n" }) as SftpLike
        const client = new FakeClient(sftp)
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshReadFileTool({ credentialResolver: new FakeCredentialResolver(), pool })
        const payload = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/tmp/file.txt", first_line: 2, last_line: 2 }, createToolContext()))
        expect(payload.content).toBe("two\n")
        expect(payload.content_truncated).toBe(false)
    })

    test("read_file retries when first_line exceeds file line count", async () => {
        const sftp = new FakeSftp({ "/tmp/file.txt": "one\ntwo\n" }) as SftpLike
        const client = new FakeClient(sftp)
        const { pool } = createFakePool(client)
        const tool = createAutocodeSshReadFileTool({ credentialResolver: new FakeCredentialResolver(), pool })
        const result = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/tmp/file.txt", first_line: 10, last_line: 20 }, createToolContext()))
        expect(Object.keys(result)).toEqual(["failedAction", "error", "instruction"])
        expect(result.failedAction).toBe("read SSH file")
        expect(result.error).toContain("first_line")
    })

    test("write_file rejects bad paths, writes content, creates directories, and reports write failures", async () => {
        const sftp = new FakeSftp({ "/srv/existing.txt": "old" }, {
            "/srv": createStats({ isFile: () => false, isDirectory: () => true }),
            "/srv/existing.txt": createStats(),
            "/srv/directory": createStats({ isFile: () => false, isDirectory: () => true }),
        }, {}, new Set(["/srv/new/file.txt", "/srv/new", "/missing", "/missing/file.txt"]))
        const { pool } = createFakePool(new FakeClient(sftp))
        const tool = createAutocodeSshWriteFileTool({ credentialResolver: new FakeCredentialResolver(), pool })

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
        const failedWrite = await tool.execute({ ssh_key: "dev", path: "/srv/existing.txt", content: "fail" }, createToolContext())
        expectSafeSshError(failedWrite, "write SSH file", "SSH operation failed")
    })

    test("edit_file validates replacements and writes exact or all matches", async () => {
        const sftp = new FakeSftp({ "/srv/file.txt": "alpha beta alpha\n", "/srv/one.txt": "hello world\n" }, { "/srv/file.txt": createStats(), "/srv/one.txt": createStats() }, {}, new Set(["/srv/new.txt"]))
        const { pool } = createFakePool(new FakeClient(sftp))
        const tool = createAutocodeSshEditFileTool({ credentialResolver: new FakeCredentialResolver(), pool })

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
        const tool = createAutocodeSshPatchFileTool({ credentialResolver: new FakeCredentialResolver(), pool })

        const successRaw = await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "@@ -2,1 +2,2 @@\n-two\n+TWO\n+deux\n" }, createToolContext())
        const success = expectJsonString(successRaw)

        expect(success).toEqual({ operation: "patch", path: "/srv/file.txt", hunks: 1, additions: 2, removals: 1, bytes: 19 })
        expect(sftp.writes.at(-1)).toEqual({ path: "/srv/file.txt", data: "one\nTWO\ndeux\nthree\n" })

        const multiHunk = parseToolResult(await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "@@ -1,1 +1,1 @@\n-one\n+ONE\n@@ -4,1 +4,1 @@\n-three\n+THREE\n" }, createToolContext()))
        expect(multiHunk).toEqual({ operation: "patch", path: "/srv/file.txt", hunks: 2, additions: 2, removals: 2, bytes: 19 })
        expect(sftp.writes.at(-1)).toEqual({ path: "/srv/file.txt", data: "ONE\nTWO\ndeux\nTHREE\n" })

        const writesBeforeMismatch = sftp.writes.length
        const mismatch = await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "@@ -1,1 +1,1 @@\n-missing\n+found\n" }, createToolContext())
        expectSafeSshError(mismatch, "patch SSH file", patchFailureDiagnostic)
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const malformed = await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "@@ nope\n-old\n+new\n" }, createToolContext())
        expectSafeSshError(malformed, "patch SSH file", patchFailureDiagnostic)
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const missingHunk = await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "--- a/file\n+++ b/file\n" }, createToolContext())
        expectSafeSshError(missingHunk, "patch SSH file", patchFailureDiagnostic)
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const badCount = await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "@@ -1,2 +1,1 @@\n-ONE\n+one\n" }, createToolContext())
        expectSafeSshError(badCount, "patch SSH file", patchFailureDiagnostic)
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const unsupported = await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "rename from old.txt\n@@ -1,1 +1,1 @@\n-ONE\n+one\n" }, createToolContext())
        expectSafeSshError(unsupported, "patch SSH file", patchFailureDiagnostic)
        expect(sftp.writes.length).toBe(writesBeforeMismatch)

        const unsupportedCreate = await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "new file mode 100644\n@@ -1,0 +1,1 @@\n+created\n" }, createToolContext())
        const unsupportedDelete = await tool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "deleted file mode 100644\n@@ -1,1 +0,0 @@\n-ONE\n" }, createToolContext())
        expectSafeSshError(unsupportedCreate, "patch SSH file", patchFailureDiagnostic)
        expectSafeSshError(unsupportedDelete, "patch SSH file", patchFailureDiagnostic)
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
        const tool = createAutocodeSshGlobTool({ credentialResolver: new FakeCredentialResolver(), pool })

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
        const limitedTool = createAutocodeSshGlobTool({ credentialResolver: new FakeCredentialResolver(), pool: createFakePool(new FakeClient(limitedSftp)).pool })
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
        const tool = createAutocodeSshGrepFileTool({ credentialResolver: new FakeCredentialResolver(), pool })

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
        const fileOnlyTool = createAutocodeSshGrepFileTool({ credentialResolver: new FakeCredentialResolver(), pool: createFakePool(new FakeClient(fileOnlySftp)).pool })
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
        const limitedTool = createAutocodeSshGrepFileTool({ credentialResolver: new FakeCredentialResolver(), pool: createFakePool(new FakeClient(limitedSftp)).pool })
        const limited = parseToolResult<Record<string, unknown>[]>(await limitedTool.execute({ ssh_key: "dev", path: "/repo", pattern: "alpha", limit: 1 }, createToolContext()))
        expect(limited.map((entry) => entry.path)).toEqual(["/repo/a.ts"])
        expect(limitedSftp.readdirCalls).toEqual(["/repo"])
        expect(limitedSftp.readFileCalls).toEqual(["/repo/a.ts"])
    })

    test("remote file tools return safe JSON error strings for representative failures", async () => {
        const globTool = createAutocodeSshGlobTool({ credentialResolver: new FakeCredentialResolver(), pool: createFakePool(new FakeClient(new FakeSftp())).pool })
        const globRaw = await globTool.execute({ ssh_key: "dev", pattern: "*.ts", path: "/repo", limit: 0 }, createToolContext())
        expectSshErrorJsonString(globRaw, "glob SSH files", "limit must be a positive integer")

        const grepTool = createAutocodeSshGrepFileTool({ credentialResolver: new FakeCredentialResolver(), pool: createFakePool(new FakeClient(new FakeSftp())).pool })
        const grepRaw = await grepTool.execute({ ssh_key: "dev", path: "/repo/src", pattern: "[" }, createToolContext())
        expectSshErrorJsonString(grepRaw, "grep SSH file", "Invalid regular expression")

        const patchSftp = new FakeSftp({ "/srv/file.txt": "one\n" }, { "/srv/file.txt": createStats() })
        const patchTool = createAutocodeSshPatchFileTool({ credentialResolver: new FakeCredentialResolver(), pool: createFakePool(new FakeClient(patchSftp)).pool })
        const patchRaw = await patchTool.execute({ ssh_key: "dev", path: "/srv/file.txt", patch: "rename from old.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n" }, createToolContext())
        expectSshErrorJsonString(patchRaw, "patch SSH file", patchFailureDiagnostic)
        expectSafeSshError(patchRaw, "patch SSH file", patchFailureDiagnostic)

        const editTool = createAutocodeSshEditFileTool({ credentialResolver: new FakeCredentialResolver(), pool: createFakePool(new FakeClient(new FakeSftp({ "/srv/one.txt": "same\n" }))).pool })
        const editRaw = await editTool.execute({ ssh_key: "dev", path: "/srv/one.txt", oldString: "same", newString: "same" }, createToolContext())
        expectSshErrorJsonString(editRaw, "edit SSH file", "oldString and newString must differ")

        const writeTool = createAutocodeSshWriteFileTool({ credentialResolver: new FakeCredentialResolver(), pool: createFakePool(new FakeClient(new FakeSftp())).pool })
        const writeRaw = await writeTool.execute({ ssh_key: "dev", path: "/srv/file.txt/", content: "x" }, createToolContext())
        {
            const parsed = expectJsonString<SshToolErrorResponse>(writeRaw)
            expect(parsed).toEqual(expect.objectContaining({
                failedAction: "write SSH file",
                error: expect.stringContaining("path must point to a file"),
                instruction: expect.any(String),
            }))
            expect(parsed.instruction).toEqual(expect.stringContaining("Provide a specific file path with no glob wildcards"))
        }
    })

    test("createTools wires SSH tool names", () => {
        const credentialResolver = new FakeCredentialResolver()
        const tools = createTools({} as Parameters<typeof createTools>[0], {}, { credentialResolver })

        expect(Object.keys(tools).filter((name) => name.startsWith("autocode_ssh_")).sort()).toEqual([
            "autocode_ssh_command",
            "autocode_ssh_config_read",
            "autocode_ssh_config_remove",
            "autocode_ssh_config_edit",
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
        expect(credentialResolver.calls).toEqual([])
    })
})

describe("SSH credential boundary regressions", () => {
    test.each(["command", "SFTP"] as const)("injected %s success never reads SSH credential environment", async (mode) => {
        await withCredentialEnvTrap(async (accesses) => {
            const sftp = new FakeSftp({ "/srv/profile.txt": "profile-only file\n" })
            const client = new FakeClient(sftp, () => ({ stdout: "profile-only command\n" }))
            const { configs, pool } = createFakePool(client)
            const credentialResolver = new FakeCredentialResolver(profileWithPassword, "DEV_WEST")
            const deps = { credentialResolver, pool }
            const result = mode === "command"
                ? await createAutocodeSshCommandTool(deps).execute({ ssh_key: " dev-west ", command: "read-profile" }, createToolContext())
                : await createAutocodeSshReadFileTool(deps).execute({ ssh_key: " dev-west ", path: "/srv/profile.txt" }, createToolContext())

            const payload = parseToolResult(result)
            expect(payload).toMatchObject({ host: "ssh.example", port: 2200 })
            if (mode === "command") expect(payload.output).toBe("profile-only command\n")
            else expect(payload.content).toBe("profile-only file\n")
            expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV_WEST" }])
            expect(configs).toHaveLength(1)
            expect(configs[0].connectConfig).toMatchObject({ host: "ssh.example", port: 2200, username: "devuser", password: "secret" })
            expect(client.sftpCalls).toBe(mode === "SFTP" ? 1 : 0)
            expect(accesses).toEqual([])
        })
    })

    test.each(["command", "SFTP"] as const)("injected %s resolver failure never reads environment or acquires IO", async (mode) => {
        await withCredentialEnvTrap(async (accesses) => {
            const sftp = new FakeSftp()
            const client = new FakeClient(sftp)
            const { configs, pool } = createFakePool(client)
            const credentialResolver = new FakeCredentialResolver(profileWithPassword, "DEV_WEST")
            credentialResolver.error = new Error(credentialFailure)
            const deps = { credentialResolver, pool }
            const result = mode === "command"
                ? await createAutocodeSshCommandTool(deps).execute({ ssh_key: " dev-west ", command: "read-profile" }, createToolContext())
                : await createAutocodeSshReadFileTool(deps).execute({ ssh_key: " dev-west ", path: "/srv/profile.txt" }, createToolContext())

            expectSafeSshError(result, "resolve SSH config", "SSH credential resolution failed")
            expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV_WEST" }])
            expect(configs).toEqual([])
            expect(client.connectConfigs).toEqual([])
            expect(client.commands).toEqual([])
            expect(client.sftpCalls).toBe(0)
            expect(sftp.readFileCalls).toEqual([])
            expect(accesses).toEqual([])
        })
    })

    const boundaries = ["resolver", "connect", "operation", "exec", "SFTP acquisition", "SFTP read"] as const
    test.each(boundaries.flatMap((boundary) => (["string", "object"] as const).map((form) => ({ boundary, form }))))("$boundary rejects secret-bearing $form payloads without evaluating hooks", async ({ boundary, form }) => {
        const keyfile = await createKeyFile(secretMarkers.privateKey)
        const credentialResolver = new FakeCredentialResolver({ ...profileWithPassword, password: secretMarkers.password, keypass: secretMarkers.keypass, keyfile })
        const hostile = form === "object" ? createHostileFailure() : undefined
        const payload = hostile?.payload ?? credentialFailure
        const sftp = new FakeSftp({ "/srv/boundary.txt": "profile-only\n" })
        const client = new FakeClient(sftp)
        if (boundary === "resolver") credentialResolver.error = payload
        if (boundary === "connect") client.connectError = payload
        if (boundary === "exec") client.execError = payload
        if (boundary === "SFTP acquisition") client.sftpError = payload
        if (boundary === "SFTP read") sftp.readError = payload
        const { configs, pool: fakePool } = createFakePool(client)
        const connectingPool = boundary === "connect" ? new SshConnectionPool({ clientFactory: () => client }) : undefined
        const deps = { credentialResolver, pool: connectingPool ?? fakePool }
        let operationCalls = 0

        try {
            let result: unknown
            if (boundary === "operation") {
                result = await withSftp("dev", deps, "run mocked SFTP operation", async () => {
                    operationCalls += 1
                    throw payload
                })
            }
            else if (boundary === "SFTP acquisition" || boundary === "SFTP read") {
                result = await createAutocodeSshReadFileTool(deps).execute({ ssh_key: "dev", path: "/srv/boundary.txt" }, createToolContext())
            }
            else {
                result = await createAutocodeSshCommandTool(deps).execute({ ssh_key: "dev", command: "read-profile" }, createToolContext())
            }

            const failedAction = boundary === "resolver" ? "resolve SSH config"
                : boundary === "operation" ? "run mocked SFTP operation"
                : boundary === "SFTP acquisition" || boundary === "SFTP read" ? "read SSH file" : "execute SSH command"
            expectSafeSshError(result, failedAction, boundary === "resolver" ? "SSH credential resolution failed" : "SSH operation failed")
            expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
            expect(configs).toHaveLength(boundary === "resolver" || boundary === "connect" ? 0 : 1)
            expect(client.connectConfigs).toHaveLength(boundary === "connect" ? 1 : 0)
            expect(client.commands).toEqual(boundary === "exec" ? ["read-profile"] : [])
            expect(client.sftpCalls).toBe(boundary === "operation" || boundary === "SFTP acquisition" || boundary === "SFTP read" ? 1 : 0)
            expect(sftp.readFileCalls).toEqual(boundary === "SFTP read" ? ["/srv/boundary.txt"] : [])
            expect(operationCalls).toBe(boundary === "operation" ? 1 : 0)
            if (boundary !== "resolver") {
                const connectConfig = boundary === "connect" ? client.connectConfigs[0] : configs[0].connectConfig
                expect(connectConfig).toMatchObject({ password: secretMarkers.password, passphrase: secretMarkers.keypass, privateKey: secretMarkers.privateKey })
            }
            if (hostile) {
                expect(hostile.counters).toEqual({ message: 0, password: 0, keypass: 0, privateKey: 0, cause: 0, toJSON: 0, toString: 0, toPrimitive: 0 })
            }
        }
        finally {
            connectingPool?.close()
        }
    })

    test.each([
        { name: "ordinary text", response: "  profile-only text\r\n" },
        { name: "formatted JSON data", response: ' { "data": [1, 2], "error": "application data" }\n' },
        { name: "missing instruction", response: '{ "failedAction": "data", "error": "application data" }' },
        { name: "non-string instruction", response: '{ "failedAction": "data", "error": "application data", "instruction": 7 }' },
        { name: "array data", response: '[{"failedAction":"data","error":"application data","instruction":"data"}]' },
        { name: "JSON scalar", response: '"profile-only JSON string"' },
        { name: "JSON null", response: "null" },
    ])("withSftp preserves $name byte-for-byte", async ({ response }) => {
        const path = "/srv/passthrough.txt"
        const content = "unchanged SFTP fixture\n"
        const sftp = new FakeSftp({ [path]: content })
        const client = new FakeClient(sftp)
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver(profileWithPassword, "DEV_WEST")
        const result = await withSftp(" dev-west ", { credentialResolver, pool }, "return mocked SFTP data", async (context) => {
            expect(await sftpReadFile(context.sftp, path, "utf8")).toBe(content)
            return response
        })

        expect(result).toBe(response)
        expect(sftp.readFileCalls).toEqual([path])
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV_WEST" }])
        expect(configs).toHaveLength(1)
        expect(client.sftpCalls).toBe(1)
    })

    test.each(["string", "object"] as const)("SFTP %s callback failure is sanitized before core retry metadata", async (form) => {
        const path = "/srv/profile.json"
        const hostile = form === "object" ? createHostileFailure() : undefined
        const sftp = new FakeSftp()
        sftp.readError = hostile?.payload ?? credentialFailure
        const client = new FakeClient(sftp)
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver()
        const failedAction = "read mocked response metadata"
        const instruction = "Adjust only this mocked response input."
        const metadata = { path, retryable: true, details: { operation: "read", attempt: 1 } }
        resetRetryCounts()

        try {
            const result = await withSftp("dev", { credentialResolver, pool }, "perform mocked SFTP read", async (context) => {
                try {
                    await sftpReadFile(context.sftp, path, "utf8")
                }
                catch (error: unknown) {
                    expect(error).toBeInstanceOf(Error)
                    expect((error as Error).message).toBe("SSH operation failed")
                    const response = JSON.parse(createRetryResponse(failedAction, error, instruction)) as Record<string, unknown>
                    return JSON.stringify({ ...response, ...metadata })
                }
                return "UNEXPECTED_READ_SUCCESS"
            })

            const parsed = expectJsonString(result)
            expect(Object.keys(parsed)).toEqual(["failedAction", "error", "instruction", "path", "retryable", "details"])
            expect(parsed).toEqual({ failedAction, error: "SSH operation failed", instruction, ...metadata })
            expect((parsed.instruction as string).trim().length).toBeGreaterThan(0)
            for (const marker of Object.values(secretMarkers)) expect(result).not.toContain(marker)
            if (hostile) expect(hostile.counters).toEqual({ message: 0, password: 0, keypass: 0, privateKey: 0, cause: 0, toJSON: 0, toString: 0, toPrimitive: 0 })
            expect(sftp.readFileCalls).toEqual([path])
            expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
            expect(configs).toHaveLength(1)
            expect(client.sftpCalls).toBe(1)
        }
        finally {
            resetRetryCounts()
        }
    })

    test("SFTP callback sanitization preserves core retry thresholds without double-counting", async () => {
        const failedAction = "SSH sanitizer retry boundary regression"
        const instruction = "Change only the mocked SSH sanitizer retry condition."
        const path = "/srv/retry.json"
        const hostile = createHostileFailure()
        const sftp = new FakeSftp()
        sftp.readError = hostile.payload
        const client = new FakeClient(sftp)
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver(profileWithPassword, "DEV_WEST")
        resetRetryCounts()

        try {
            for (let attempt = 1; attempt <= 6; attempt += 1) {
                const callsBefore = credentialResolver.calls.length
                const result = await withSftp(" dev-west ", { credentialResolver, pool }, failedAction, async (context) => {
                    try {
                        await sftpReadFile(context.sftp, path, "utf8")
                    }
                    catch (error: unknown) {
                        expect(error).toBeInstanceOf(Error)
                        expect((error as Error).message).toBe("SSH operation failed")
                        return createRetryResponse(failedAction, error, instruction)
                    }
                    return "UNEXPECTED_READ_SUCCESS"
                })

                expectSafeSshError(result, failedAction, "SSH operation failed")
                const parsed = parseToolResult(result)
                if (attempt <= 5) expect(parsed.instruction).toBe(instruction)
                else {
                    expect(parsed.instruction).toEqual(expect.stringContaining("Immediately ABORT your flow"))
                    expect(parsed.instruction).not.toBe(instruction)
                }
                expect(credentialResolver.calls.slice(callsBefore)).toEqual([{ kind: "ssh", id: "DEV_WEST" }])
                expect(configs).toHaveLength(attempt)
                expect(client.sftpCalls).toBe(attempt)
                expect(sftp.readFileCalls).toEqual(Array.from({ length: attempt }, () => path))
                expect(hostile.counters).toEqual({ message: 0, password: 0, keypass: 0, privateKey: 0, cause: 0, toJSON: 0, toString: 0, toPrimitive: 0 })
            }
        }
        finally {
            resetRetryCounts()
        }
    })
})

describe("safe SFTP decorator", () => {
    test("preserves receivers, both read overloads, and absent rename", async () => {
        const binaryPath = "/srv/binary.dat"
        const textPath = "/srv/text.txt"
        const binary = Buffer.from([0, 1, 255])
        const text = "unchanged encoded content ☃\n"
        const sftp = new FakeSftp()
        const client = new FakeClient(sftp)
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver()
        const result = await withSftp("dev", { credentialResolver, pool }, "read mocked overloads", async (context) => {
            sftp.readData = binary
            const binaryResult = await new Promise<Buffer>((resolve, reject) => {
                context.sftp.readFile(binaryPath, (error, data) => {
                    if (error) reject(error)
                    else resolve(data)
                })
            })
            expect(binaryResult).toBe(binary)

            sftp.readData = text
            const textResult = await new Promise<Buffer | string>((resolve, reject) => {
                context.sftp.readFile(textPath, "utf8", (error, data) => {
                    if (error) reject(error)
                    else resolve(data)
                })
            })
            expect(textResult).toBe(text)
            expect(typeof textResult).toBe("string")
            expect("rename" in context.sftp).toBe(false)
            expect(context.sftp.rename).toBeUndefined()
            return "READ_OVERLOADS_OK"
        })

        expect(result).toBe("READ_OVERLOADS_OK")
        expect(sftp.readFileCalls).toEqual([binaryPath, textPath])
        expect(sftp.readEncodings).toEqual([undefined, "utf8"])
        expect(sftp.readReceivers).toHaveLength(2)
        expect(sftp.readReceivers[0]).toBe(sftp)
        expect(sftp.readReceivers[1]).toBe(sftp)
        expect("rename" in sftp).toBe(false)
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
        expect(configs).toHaveLength(1)
        expect(client.sftpCalls).toBe(1)
    })

    test.each(["ENOENT", 2] as const)("preserves missing-path data code %s without secret text", async (code) => {
        const path = "/srv/missing.txt"
        const rawError = Object.assign(new Error(credentialFailure), { code })
        const sftp = new FakeSftp()
        sftp.statError = rawError
        const client = new FakeClient(sftp)
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver()
        let sanitized: unknown
        const result = await withSftp("dev", { credentialResolver, pool }, "inspect mocked missing path", async (context) => {
            expect(await statIfExists(context.sftp, path)).toBeUndefined()
            try {
                await sftpStat(context.sftp, path)
            }
            catch (error: unknown) {
                sanitized = error
            }
            return "MISSING_PATH_HANDLED"
        })

        expect(result).toBe("MISSING_PATH_HANDLED")
        expect(sanitized).toBeInstanceOf(Error)
        expect(sanitized).not.toBe(rawError)
        const safeError = sanitized as Error & { code?: unknown }
        expect(safeError.message).toBe("SSH file or directory not found")
        expect(Object.getOwnPropertyDescriptor(safeError, "code")).toMatchObject({ value: code })
        expect(safeError.code).toBe(code)
        const detail = JSON.stringify({ code: safeError.code, message: safeError.message })
        for (const marker of Object.values(secretMarkers)) expect(detail).not.toContain(marker)
        expect(rawError.message).toBe(credentialFailure)
        expect(sftp.statCalls).toEqual([path, path])
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
        expect(configs).toHaveLength(1)
        expect(client.sftpCalls).toBe(1)
    })

    test.each([
        { code: "EEXIST", message: "SSH directory already exists" },
        { code: 4, message: "SSH directory creation failure" },
    ])("preserves mkdir data code $code through write_file parent creation", async ({ code, message }) => {
        const path = "/srv/new/file.txt"
        const rawError = Object.assign(new Error(credentialFailure), { code })
        const sftp = new FakeSftp({}, {}, {}, new Set([path]))
        sftp.mkdirError = rawError
        const client = new FakeClient(sftp)
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver()
        const deps = { credentialResolver, pool }
        let sanitized: unknown
        const probe = await withSftp("dev", deps, "inspect mocked mkdir failure", async (context) => {
            try {
                await sftpMkdir(context.sftp, "/srv/probe")
            }
            catch (error: unknown) {
                sanitized = error
            }
            return "MKDIR_ERROR_INSPECTED"
        })

        expect(probe).toBe("MKDIR_ERROR_INSPECTED")
        expect(sanitized).toBeInstanceOf(Error)
        const safeError = sanitized as Error & { code?: unknown }
        expect(safeError.message).toBe(message)
        expect(Object.getOwnPropertyDescriptor(safeError, "code")).toMatchObject({ value: code })
        expect(safeError.code).toBe(code)
        const detail = JSON.stringify({ code: safeError.code, message: safeError.message })
        for (const marker of Object.values(secretMarkers)) expect(detail).not.toContain(marker)
        expect(rawError.message).toBe(credentialFailure)
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])

        const result = await createAutocodeSshWriteFileTool(deps).execute({ ssh_key: "dev", path, content: "created", create_dirs: true }, createToolContext())

        const payload = expectJsonString(result)
        expect(payload).toEqual({ operation: "write", path, bytes: 7, existed: false })
        expect(sftp.mkdirs).toEqual(["/srv/probe", "/srv", "/srv/new"])
        expect(sftp.writes).toEqual([{ path, data: "created" }])
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }, { kind: "ssh", id: "DEV" }])
        expect(configs).toHaveLength(2)
        expect(client.sftpCalls).toBe(2)
    })

    test.each(["synchronous throw", "callback"] as const)("ignores hostile getters and hooks for %s failures", async (boundary) => {
        const hostile = createHostileFailure()
        const propertyReads = { custom: 0, code: 0 }
        Object.defineProperties(hostile.payload, {
            custom: {
                enumerable: true,
                get(): string {
                    propertyReads.custom += 1
                    return credentialFailure
                },
            },
            code: {
                enumerable: true,
                get(): string {
                    propertyReads.code += 1
                    return credentialFailure
                },
            },
        })
        const path = "/srv/hostile.txt"
        const sftp = new FakeSftp()
        if (boundary === "synchronous throw") sftp.readThrow = hostile.payload
        else sftp.readError = hostile.payload
        const client = new FakeClient(sftp)
        const { configs, pool } = createFakePool(client)
        const credentialResolver = new FakeCredentialResolver()
        const result = await createAutocodeSshReadFileTool({ credentialResolver, pool }).execute({ ssh_key: "dev", path }, createToolContext())

        expectSafeSshError(result, "read SSH file", "SSH operation failed")
        expect(propertyReads).toEqual({ custom: 0, code: 0 })
        expect(hostile.counters).toEqual({ message: 0, password: 0, keypass: 0, privateKey: 0, cause: 0, toJSON: 0, toString: 0, toPrimitive: 0 })
        expect(sftp.readFileCalls).toEqual([path])
        expect(credentialResolver.calls).toEqual([{ kind: "ssh", id: "DEV" }])
        expect(configs).toHaveLength(1)
        expect(client.sftpCalls).toBe(1)
    })
})
