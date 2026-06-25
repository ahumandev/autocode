import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { ConnectConfig, FileEntryWithStats, Stats } from "ssh2"
import {
    DEFAULT_SSH_IDLE_TIMEOUT_MS,
    SshConnectionPool,
    createSshToolAbortResponse,
    createSshToolErrorResponse,
    execSshCommand,
    openSftp,
    parseSshHostPort,
    resolveSshConfig,
    selectSshAuth,
    sftpMkdir,
    sftpReadFile,
    sftpReaddir,
    sftpStat,
    sftpUnlink,
    sftpWriteFile,
    truncateSshOutput,
    type SftpLike,
    type SshChannelLike,
    type SshClientLike,
    type SshResolvedConfig,
} from "./ssh"

class FakeReadable extends EventEmitter {
    emitData(chunk: Buffer | string): void {
        this.emit("data", chunk)
    }
}

class FakeChannel extends FakeReadable {
    readonly stderr = new FakeReadable()
    closed = false
    destroyed = false

    close(): void {
        this.closed = true
        this.emit("close")
    }

    destroy(): void {
        this.destroyed = true
        this.emit("close")
    }
}

class FakeClient extends EventEmitter {
    ended = false
    connectConfig?: ConnectConfig
    execChannel?: FakeChannel
    execError?: Error
    sftpResult?: SftpLike
    sftpError?: Error

    connect(config: ConnectConfig): void {
        this.connectConfig = config
    }

    exec(_command: string, callback: (err: Error | undefined, channel: SshChannelLike) => void): void {
        callback(this.execError, this.execChannel as SshChannelLike)
    }

    sftp(callback: (err: Error | undefined, sftp: SftpLike) => void): void {
        callback(this.sftpError, this.sftpResult as SftpLike)
    }

    end(): void {
        this.ended = true
    }
}

function baseConfig(overrides?: Partial<SshResolvedConfig>): SshResolvedConfig {
    return {
        key: "prod",
        host: "example.com",
        port: 22,
        username: "deploy",
        auth: { method: "password", password: "secret" },
        connectConfig: { host: "example.com", port: 22, username: "deploy", password: "secret" },
        ...overrides,
    }
}

function createFakeSftp(options?: { fail?: keyof SftpLike }): SftpLike {
    const stats: Stats = {
        mode: 0,
        uid: 0,
        gid: 0,
        size: 12,
        atime: 0,
        mtime: 0,
        isDirectory(): boolean {
            return false
        },
        isFile(): boolean {
            return true
        },
        isBlockDevice(): boolean {
            return false
        },
        isCharacterDevice(): boolean {
            return false
        },
        isSymbolicLink(): boolean {
            return false
        },
        isFIFO(): boolean {
            return false
        },
        isSocket(): boolean {
            return false
        },
    }
    const entries: FileEntryWithStats[] = [{ filename: "file.txt", longname: "file.txt", attrs: stats }]
    const maybeError = (method: keyof SftpLike): Error | undefined => options?.fail === method ? new Error(`${method} failed`) : undefined

    return {
        readFile(path: string, encodingOrCallback: BufferEncoding | ((err: Error | undefined, data: Buffer) => void), callback?: (err: Error | undefined, data: Buffer) => void): void {
            const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback
            done?.(maybeError("readFile"), Buffer.from(`data:${path}`))
        },
        writeFile(_path: string, _data: string | Buffer, callback: (err: Error | undefined) => void): void {
            callback(maybeError("writeFile"))
        },
        stat(_path: string, callback: (err: Error | undefined, result: Stats) => void): void {
            callback(maybeError("stat"), stats)
        },
        mkdir(_path: string, callback: (err: Error | undefined) => void): void {
            callback(maybeError("mkdir"))
        },
        readdir(_path: string, callback: (err: Error | undefined, list: FileEntryWithStats[]) => void): void {
            callback(maybeError("readdir"), entries)
        },
        unlink(_path: string, callback: (err: Error | undefined) => void): void {
            callback(maybeError("unlink"))
        },
    }
}

describe("ssh utils", () => {
    test("parseSshHostPort parses host formats and rejects invalid values", () => {
        expect(parseSshHostPort("example.com")).toEqual({ host: "example.com", port: 22 })
        expect(parseSshHostPort("example.com:2222")).toEqual({ host: "example.com", port: 2222 })
        expect(parseSshHostPort("[::1]")).toEqual({ host: "::1", port: 22 })
        expect(parseSshHostPort("[::1]:2222")).toEqual({ host: "::1", port: 2222 })
        expect(parseSshHostPort("2001:db8::1")).toEqual({ host: "2001:db8::1", port: 22 })

        for (const value of ["", "   ", "example.com:0", "example.com:65536", "example.com:abc", "[]"]) {
            expect(() => parseSshHostPort(value)).toThrow()
        }
    })

    test("selectSshAuth chooses auth sources, supports no credentials, and rejects explicit missing sources", async () => {
        expect(await selectSshAuth({ host: "host", username: "user", password: "pw", passphrase: "key-pass", privateKey: "key" })).toEqual({ method: "privateKey", privateKey: "key", passphrase: "key-pass", password: "pw" })
        expect(await selectSshAuth({ host: "host", username: "user", privateKeyPath: "/key" }, { fs: { readFile: async () => "key-file" } })).toEqual({ method: "privateKey", privateKey: "key-file", passphrase: undefined })
        expect(await selectSshAuth({ host: "host", username: "user", privateKeyPath: "/key", password: "pw" }, { fs: { readFile: async () => "key-file" } })).toEqual({ method: "privateKey", privateKey: "key-file", passphrase: undefined, password: "pw" })
        expect(await selectSshAuth({ host: "host", username: "user", privateKeyPath: "/missing", password: "pw" }, { fs: { readFile: async () => { throw new Error("missing") } } })).toEqual({ method: "password", password: "pw" })
        expect(await selectSshAuth({ host: "host", username: "user", privateKeyPath: "/missing", agent: "/agent" }, { fs: { readFile: async () => { throw new Error("missing") } } })).toEqual({ method: "agent", agent: "/agent" })
        expect(await selectSshAuth({ host: "host", username: "user" })).toEqual({ method: "none" })
        expect(await selectSshAuth({ host: "host", username: "user", auth: "password", password: "pw", privateKey: "key" })).toEqual({ method: "password", password: "pw" })
        expect(await selectSshAuth({ host: "host", username: "user", auth: "agent", agent: "/agent", password: "pw" })).toEqual({ method: "agent", agent: "/agent" })

        await expect(selectSshAuth({ host: "host", username: "user", auth: "password" })).rejects.toThrow("password")
        await expect(selectSshAuth({ host: "host", username: "user", auth: "privateKey" })).rejects.toThrow("privateKey")
        await expect(selectSshAuth({ host: "host", username: "user", auth: "agent" })).rejects.toThrow("agent")
    })

    test("resolveSshConfig builds keyed ConnectConfig and pool keys omit secrets", async () => {
        const resolved = await resolveSshConfig({ prod: { host: "example.com:2200", port: 2222, username: "deploy", password: "pw", readyTimeoutMs: 10, keepaliveIntervalMs: 20 } }, "prod")
        const defaultUser = await resolveSshConfig({ prod: { host: "example.com" } }, "prod")

        expect(resolved).toMatchObject({ key: "prod", host: "example.com", port: 2222, username: "deploy" })
        expect(resolved.connectConfig).toMatchObject({ host: "example.com", port: 2222, username: "deploy", password: "pw", readyTimeout: 10, keepaliveInterval: 20 })
        expect(defaultUser.connectConfig).toMatchObject({ host: "example.com", port: 22, username: "root" })
        expect(defaultUser.auth).toEqual({ method: "none" })
        await expect(resolveSshConfig({}, "missing")).rejects.toThrow("missing")

        let now = 0
        const createdClients = [new FakeClient(), new FakeClient()]
        const queuedClients = [...createdClients]
        const pool = new SshConnectionPool({ clock: { now: () => now }, clientFactory: () => queuedClients.shift() as SshClientLike })
        const first = pool.get(resolved)
        createdClients[0]?.emit("ready")
        const firstClient = await first
        pool.release(resolved)
        now += 1
        const changedSecret = await resolveSshConfig({ prod: { host: "example.com", port: 2222, username: "deploy", password: "changed" } }, "prod")

        expect(await pool.get(changedSecret)).toBe(firstClient)
    })

    test("SshConnectionPool reuses, expires, removes failures, and closes clients", async () => {
        let now = 0
        const createdClients = [new FakeClient(), new FakeClient(), new FakeClient()]
        const queuedClients = [...createdClients]
        const pool = new SshConnectionPool({ clock: { now: () => now }, clientFactory: () => queuedClients.shift() as SshClientLike })
        const config = baseConfig()

        const firstPromise = pool.get(config)
        createdClients[0]?.emit("ready")
        const first = (await firstPromise) as FakeClient
        pool.release(config)
        now += DEFAULT_SSH_IDLE_TIMEOUT_MS - 1
        expect(await pool.get(config)).toBe(first)

        pool.release(config)
        now += DEFAULT_SSH_IDLE_TIMEOUT_MS
        const secondPromise = pool.get(config)
        expect(first.ended).toBe(true)
        createdClients[1]?.emit("ready")
        const second = (await secondPromise) as FakeClient
        expect(second).not.toBe(first)

        const failedConfig = baseConfig({ key: "failed" })
        const failedPromise = pool.get(failedConfig)
        createdClients[2]?.emit("error", new Error("connect failed"))
        await expect(failedPromise).rejects.toThrow("connect failed")
        expect(pool.size()).toBe(1)

        pool.close()
        expect(second.ended).toBe(true)
        expect(pool.size()).toBe(0)
    })

    test("execSshCommand collects output, nonzero exits, timeout close, and truncation flags", async () => {
        const client = new FakeClient()
        const channel = new FakeChannel()
        client.execChannel = channel
        const command = execSshCommand(client as SshClientLike, "false", { maxOutputBytes: 3 })
        channel.emitData("stdout")
        channel.stderr.emitData("stderr")
        channel.emit("exit", 2, "SIGTERM")
        channel.emit("close")

        await expect(command).resolves.toEqual({ stdout: "std", stderr: "std", stdoutTruncated: true, stderrTruncated: true, stdoutBytes: 6, stderrBytes: 6, exitCode: 2, signal: "SIGTERM" })

        const timeoutClient = new FakeClient()
        const timeoutChannel = new FakeChannel()
        timeoutClient.execChannel = timeoutChannel
        await expect(execSshCommand(timeoutClient as SshClientLike, "sleep", { timeoutMs: 5 })).rejects.toThrow("timed out")
        expect(timeoutChannel.closed).toBe(true)
    })

    test("SFTP helpers wrap callback successes and errors", async () => {
        const client = new FakeClient()
        const sftp = createFakeSftp()
        client.sftpResult = sftp

        await expect(openSftp(client as SshClientLike)).resolves.toBe(sftp)
        await expect(sftpReadFile(sftp, "/file", "utf8")).resolves.toBe("data:/file")
        await expect(sftpWriteFile(sftp, "/file", "content")).resolves.toBeUndefined()
        await expect(sftpStat(sftp, "/file")).resolves.toMatchObject({ size: 12 })
        await expect(sftpMkdir(sftp, "/dir")).resolves.toBeUndefined()
        await expect(sftpReaddir(sftp, "/dir")).resolves.toMatchObject([{ filename: "file.txt" }])
        await expect(sftpUnlink(sftp, "/file")).resolves.toBeUndefined()

        const errorClient = new FakeClient()
        errorClient.sftpError = new Error("sftp failed")
        await expect(openSftp(errorClient as SshClientLike)).rejects.toThrow("sftp failed")
        await expect(sftpReadFile(createFakeSftp({ fail: "readFile" }), "/file")).rejects.toThrow("readFile failed")
    })

    test("truncateSshOutput reports text, truncation, and originalBytes", () => {
        expect(truncateSshOutput("abc", 3)).toEqual({ text: "abc", truncated: false, originalBytes: 3 })
        expect(truncateSshOutput("abcdef", 3)).toEqual({ text: "abc", truncated: true, originalBytes: 6 })
    })

    test("SSH tool error helpers return normalized JSON responses", () => {
        expect(JSON.parse(createSshToolErrorResponse("connect", new Error("denied"), "fix ssh"))).toEqual({ failedAction: "connect", error: "denied", instruction: "fix ssh" })

        const abort = JSON.parse(createSshToolAbortResponse("execute", "stopped")) as Record<string, string>
        expect(abort.failedAction).toBe("execute")
        expect(abort.error).toBe("stopped")
        expect(abort.instruction).toContain("ABORT")
    })
})
