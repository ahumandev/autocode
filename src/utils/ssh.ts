import { promises as nodeFs } from "node:fs"
import { Client } from "ssh2"
import type { ConnectConfig, FileEntryWithStats, Stats } from "ssh2"
import { createAbortResponse, createErrorResponse } from "./tools"

export const DEFAULT_SSH_PORT = 22
export const DEFAULT_SSH_IDLE_TIMEOUT_MS = 5 * 60 * 1000
export const DEFAULT_SSH_COMMAND_TIMEOUT_MS = 30000
export const DEFAULT_SSH_MAX_OUTPUT_BYTES = 65536

export type SshAuthMethod = "password" | "privateKey" | "agent" | "none"

export interface SshConfigInput {
    host: string
    port?: number
    username?: string
    auth?: SshAuthMethod
    password?: string
    privateKey?: string
    privateKeyPath?: string
    passphrase?: string
    agent?: string
    readyTimeoutMs?: number
    keepaliveIntervalMs?: number
}

export type SshConfigMap = Record<string, SshConfigInput>

export interface SshResolvedConfig {
    key: string
    host: string
    port: number
    username: string
    auth: SshAuthChoice
    connectConfig: ConnectConfig
}

export interface SshFs {
    readFile(path: string, encoding: BufferEncoding): Promise<string> | string
}

export interface SshClock {
    now(): number
}

export type SshClientFactory = () => SshClientLike

export interface SshDeps {
    fs?: SshFs
    clock?: SshClock
    clientFactory?: SshClientFactory
}

export interface SshAuthChoice {
    method: SshAuthMethod
    password?: string
    privateKey?: string
    passphrase?: string
    agent?: string
}

export interface SshClientLike {
    connect(config: ConnectConfig): void
    exec(command: string, callback: (err: Error | undefined, channel: SshChannelLike) => void): void
    sftp(callback: (err: Error | undefined, sftp: SftpLike) => void): void
    end(): void
    on(event: "error", listener: (error: unknown) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
    once(event: "ready" | "close", listener: () => void): this
    once(event: "error", listener: (error: unknown) => void): this
    once(event: string, listener: (...args: unknown[]) => void): this
    removeListener(event: "ready" | "close", listener: () => void): this
    removeListener(event: "error", listener: (error: unknown) => void): this
    removeListener(event: string, listener: (...args: unknown[]) => void): this
}

export interface SshReadableLike {
    on(event: "data", listener: (chunk: Buffer | string) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
}

export interface SshChannelLike extends SshReadableLike {
    stderr: SshReadableLike
    close?(): void
    destroy?(): void
    on(event: "data", listener: (chunk: Buffer | string) => void): this
    on(event: "close", listener: () => void): this
    on(event: "error", listener: (error: unknown) => void): this
    on(event: "exit", listener: (code: unknown, signal: unknown) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
}

export interface SftpLike {
    readFile(path: string, callback: (err: Error | undefined, data: Buffer) => void): void
    readFile(path: string, encoding: BufferEncoding, callback: (err: Error | undefined, data: Buffer) => void): void
    writeFile(path: string, data: string | Buffer, callback: (err: Error | undefined) => void): void
    stat(path: string, callback: (err: Error | undefined, stats: Stats) => void): void
    mkdir(path: string, callback: (err: Error | undefined) => void): void
    readdir(path: string, callback: (err: Error | undefined, list: FileEntryWithStats[]) => void): void
    unlink(path: string, callback: (err: Error | undefined) => void): void
    rename?(oldPath: string, newPath: string, callback: (err: Error | undefined) => void): void
}

export interface SshExecOptions {
    timeoutMs?: number
    maxOutputBytes?: number
    encoding?: BufferEncoding
}

export interface SshTruncatedOutput {
    text: string
    truncated: boolean
    originalBytes: number
}

export interface SshExecResult {
    stdout: string
    stderr: string
    stdoutTruncated: boolean
    stderrTruncated: boolean
    stdoutBytes: number
    stderrBytes: number
    exitCode?: number
    signal?: string
}

interface PoolEntry {
    client: SshClientLike
    lastUsed: number
    connecting?: Promise<SshClientLike>
}

const systemClock: SshClock = {
    now(): number {
        return Date.now()
    },
}

export function parseSshHostPort(value: string, defaultPort = DEFAULT_SSH_PORT): { host: string; port: number } {
    const trimmed = value.trim()

    if (!trimmed) {
        throw new Error("SSH host is required")
    }

    const parsed = parseSshUrl(trimmed)
    const hostPort = parsed ?? parseRawHostPort(trimmed, defaultPort)

    validateSshPort(hostPort.port)
    return hostPort
}

export async function selectSshAuth(config: SshConfigInput, deps?: Pick<SshDeps, "fs">): Promise<SshAuthChoice> {
    const method = config.auth ?? inferSshAuthMethod(config)

    if (method === "privateKey") {
        const auth = await selectPrivateKeyAuth(config, deps)
        if (auth) {
            return auth
        }

        if (config.password) {
            return { method: "password", password: config.password }
        }

        return config.agent ? { method: "agent", agent: config.agent } : { method: "none" }
    }

    if (method === "password") {
        if (!config.password) {
            throw new Error("SSH password auth requires password")
        }

        return { method, password: config.password }
    }

    if (method === "agent") {
        if (!config.agent && config.auth === "agent") {
            throw new Error("SSH agent auth requires agent")
        }

        return config.agent ? { method, agent: config.agent } : { method }
    }

    return { method: "none" }
}

export async function resolveSshConfig(configs: SshConfigMap, key: string, deps?: SshDeps): Promise<SshResolvedConfig> {
    const config = configs[key]

    if (!config) {
        throw new Error(`SSH config not found for key: ${key}`)
    }

    const parsed = parseSshHostPort(config.host, config.port ?? DEFAULT_SSH_PORT)
    const port = config.port ?? parsed.port
    validateSshPort(port)

    const username = config.username?.trim() || "root"
    const auth = await selectSshAuth(config, deps)
    const connectConfig: ConnectConfig = {
        host: parsed.host,
        port,
        username,
    }

    applyAuth(connectConfig, auth)

    if (config.readyTimeoutMs !== undefined) {
        connectConfig.readyTimeout = config.readyTimeoutMs
    }

    if (config.keepaliveIntervalMs !== undefined) {
        connectConfig.keepaliveInterval = config.keepaliveIntervalMs
    }

    return { key, host: parsed.host, port, username, auth, connectConfig }
}

export class SshConnectionPool {
    private readonly idleTimeoutMs: number
    private readonly clock: SshClock
    private readonly clientFactory: SshClientFactory
    private readonly entries = new Map<string, PoolEntry>()

    constructor(options?: { idleTimeoutMs?: number; clock?: SshClock; clientFactory?: SshClientFactory }) {
        this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_SSH_IDLE_TIMEOUT_MS
        this.clock = options?.clock ?? systemClock
        this.clientFactory = options?.clientFactory ?? createDefaultSshClient
    }

    async get(config: SshResolvedConfig): Promise<SshClientLike> {
        this.pruneIdle()

        const key = this.poolKey(config)
        const existing = this.entries.get(key)

        if (existing) {
            existing.lastUsed = this.clock.now()
            return existing.connecting ?? existing.client
        }

        const client = this.clientFactory()
        const entry: PoolEntry = { client, lastUsed: this.clock.now() }
        entry.connecting = this.connectClient(client, config, key)
        this.entries.set(key, entry)

        try {
            const connected = await entry.connecting
            entry.connecting = undefined
            entry.lastUsed = this.clock.now()
            this.removeEntryOnDisconnect(connected, key)
            return connected
        } catch (error) {
            this.entries.delete(key)
            safeEnd(client)
            throw error
        }
    }

    release(config: SshResolvedConfig): void {
        const entry = this.entries.get(this.poolKey(config))

        if (entry) {
            entry.lastUsed = this.clock.now()
        }
    }

    pruneIdle(): void {
        const now = this.clock.now()

        for (const [key, entry] of this.entries) {
            if (now - entry.lastUsed >= this.idleTimeoutMs) {
                safeEnd(entry.client)
                this.entries.delete(key)
            }
        }
    }

    close(config?: SshResolvedConfig): void {
        if (config) {
            const key = this.poolKey(config)
            const entry = this.entries.get(key)
            if (entry) {
                safeEnd(entry.client)
                this.entries.delete(key)
            }
            return
        }

        for (const entry of this.entries.values()) {
            safeEnd(entry.client)
        }
        this.entries.clear()
    }

    size(): number {
        return this.entries.size
    }

    private poolKey(config: SshResolvedConfig): string {
        return [config.key, config.host, config.port, config.username, config.auth.method].join("|")
    }

    private connectClient(client: SshClientLike, config: SshResolvedConfig, key: string): Promise<SshClientLike> {
        return new Promise<SshClientLike>((resolve, reject) => {
            const cleanup = (): void => {
                client.removeListener("ready", onReady)
                client.removeListener("error", onError)
                client.removeListener("close", onClose)
            }
            const fail = (error: Error): void => {
                cleanup()
                this.entries.delete(key)
                reject(error)
            }
            const onReady = (): void => {
                cleanup()
                resolve(client)
            }
            const onError = (error: unknown): void => {
                fail(toError(error, "SSH connection failed"))
            }
            const onClose = (): void => {
                fail(new Error("SSH connection closed before ready"))
            }

            client.once("ready", onReady)
            client.once("error", onError)
            client.once("close", onClose)
            client.connect(config.connectConfig)
        })
    }

    private removeEntryOnDisconnect(client: SshClientLike, key: string): void {
        const remove = (): void => {
            const entry = this.entries.get(key)
            if (entry?.client === client) {
                this.entries.delete(key)
            }
        }

        client.once("close", remove)
        client.once("error", remove)
    }
}

export async function execSshCommand(
    client: SshClientLike,
    command: string,
    options?: SshExecOptions
): Promise<SshExecResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS
    const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_SSH_MAX_OUTPUT_BYTES
    const encoding = options?.encoding ?? "utf8"

    return new Promise<SshExecResult>((resolve, reject) => {
        client.exec(command, (execError, channel) => {
            if (execError) {
                reject(execError)
                return
            }

            collectCommandOutput(channel, { timeoutMs, maxOutputBytes, encoding }, resolve, reject)
        })
    })
}

export async function openSftp(client: SshClientLike): Promise<SftpLike> {
    return new Promise<SftpLike>((resolve, reject) => {
        client.sftp((error, sftp) => {
            if (error) {
                reject(error)
                return
            }

            resolve(sftp)
        })
    })
}

export async function sftpReadFile(sftp: SftpLike, path: string, encoding?: BufferEncoding): Promise<Buffer | string> {
    return new Promise<Buffer | string>((resolve, reject) => {
        const callback = (error: Error | undefined, data: Buffer): void => {
            if (error) {
                reject(error)
                return
            }

            resolve(encoding ? data.toString(encoding) : data)
        }

        if (encoding) {
            sftp.readFile(path, encoding, callback)
            return
        }

        sftp.readFile(path, callback)
    })
}

export async function sftpWriteFile(sftp: SftpLike, path: string, data: string | Buffer): Promise<void> {
    return wrapSftpVoid((callback) => sftp.writeFile(path, data, callback))
}

export async function sftpStat(sftp: SftpLike, path: string): Promise<Stats> {
    return new Promise<Stats>((resolve, reject) => {
        sftp.stat(path, (error, stats) => {
            if (error) {
                reject(error)
                return
            }

            resolve(stats)
        })
    })
}

export async function sftpMkdir(sftp: SftpLike, path: string): Promise<void> {
    return wrapSftpVoid((callback) => sftp.mkdir(path, callback))
}

export async function sftpReaddir(sftp: SftpLike, path: string): Promise<FileEntryWithStats[]> {
    return new Promise<FileEntryWithStats[]>((resolve, reject) => {
        sftp.readdir(path, (error, list) => {
            if (error) {
                reject(error)
                return
            }

            resolve(list)
        })
    })
}

export async function sftpUnlink(sftp: SftpLike, path: string): Promise<void> {
    return wrapSftpVoid((callback) => sftp.unlink(path, callback))
}

export async function sftpRename(sftp: SftpLike, oldPath: string, newPath: string): Promise<void> {
    const rename = sftp.rename
    if (!rename) throw new Error("SFTP rename is not supported by this client")
    return wrapSftpVoid((callback) => rename.call(sftp, oldPath, newPath, callback))
}

export function truncateSshOutput(
    input: string | Buffer,
    maxBytes = DEFAULT_SSH_MAX_OUTPUT_BYTES,
    encoding: BufferEncoding = "utf8"
): SshTruncatedOutput {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, encoding)
    const originalBytes = buffer.byteLength

    if (originalBytes <= maxBytes) {
        return { text: buffer.toString(encoding), truncated: false, originalBytes }
    }

    return { text: buffer.subarray(0, maxBytes).toString(encoding), truncated: true, originalBytes }
}

export function createSshToolErrorResponse(failedAction: string, error: unknown, instruction?: string): string {
    return createErrorResponse(failedAction, error, instruction ?? defaultSshFailureInstruction())
}

export function createSshToolAbortResponse(failedAction: string, error: unknown): string {
    return createAbortResponse(failedAction, error)
}

function parseSshUrl(value: string): { host: string; port: number } | undefined {
    if (!value.startsWith("ssh://")) {
        return undefined
    }

    const url = new URL(value)

    if (url.username || url.password) {
        throw new Error("SSH URL must not include username or password")
    }

    return { host: stripIpv6Brackets(url.hostname), port: url.port ? parsePort(url.port) : DEFAULT_SSH_PORT }
}

function parseRawHostPort(value: string, defaultPort: number): { host: string; port: number } {
    if (value.startsWith("[")) {
        return parseBracketHostPort(value, defaultPort)
    }

    const colonCount = (value.match(/:/g) ?? []).length

    if (colonCount === 1) {
        const [host, port] = value.split(":")
        if (!host) {
            throw new Error("SSH host is required")
        }

        return { host, port: parsePort(port) }
    }

    return { host: value, port: defaultPort }
}

function parseBracketHostPort(value: string, defaultPort: number): { host: string; port: number } {
    const end = value.indexOf("]")

    if (end < 0) {
        throw new Error("SSH bracketed IPv6 host is missing closing bracket")
    }

    const host = value.slice(1, end)
    const remainder = value.slice(end + 1)

    if (!host) {
        throw new Error("SSH host is required")
    }

    if (!remainder) {
        return { host, port: defaultPort }
    }

    if (!remainder.startsWith(":")) {
        throw new Error("SSH bracketed host may only be followed by a port")
    }

    return { host, port: parsePort(remainder.slice(1)) }
}

function parsePort(value: string): number {
    if (!/^\d+$/.test(value)) {
        throw new Error("SSH port must be an integer")
    }

    const port = Number(value)
    validateSshPort(port)
    return port
}

function validateSshPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("SSH port must be between 1 and 65535")
    }
}

function inferSshAuthMethod(config: SshConfigInput): SshAuthMethod {
    if (config.privateKey || config.privateKeyPath) {
        return "privateKey"
    }

    if (config.password) {
        return "password"
    }

    if (config.agent) {
        return "agent"
    }

    return "none"
}

async function selectPrivateKeyAuth(config: SshConfigInput, deps?: Pick<SshDeps, "fs">): Promise<SshAuthChoice | undefined> {
    const privateKey = config.privateKey ?? (await readPrivateKey(config, deps).catch(() => undefined))

    if (!privateKey) {
        if (config.auth === "privateKey") {
            throw new Error("SSH private key auth requires privateKey or privateKeyPath")
        }

        return undefined
    }

    return { method: "privateKey", privateKey, passphrase: config.passphrase, password: config.password }
}

async function readPrivateKey(config: SshConfigInput, deps?: Pick<SshDeps, "fs">): Promise<string | undefined> {
    if (!config.privateKeyPath) {
        return undefined
    }

    if (deps?.fs) {
        return deps.fs.readFile(config.privateKeyPath, "utf8")
    }

    return nodeFs.readFile(config.privateKeyPath, "utf8")
}

function stripIpv6Brackets(host: string): string {
    if (host.startsWith("[") && host.endsWith("]")) {
        return host.slice(1, -1)
    }

    return host
}

function applyAuth(connectConfig: ConnectConfig, auth: SshAuthChoice): void {
    if (auth.method === "privateKey") {
        connectConfig.privateKey = auth.privateKey
        connectConfig.passphrase = auth.passphrase
        connectConfig.password = auth.password
        return
    }

    if (auth.method === "password") {
        connectConfig.password = auth.password
        return
    }

    if (auth.method === "agent") {
        connectConfig.agent = auth.agent
    }
}

function createDefaultSshClient(): SshClientLike {
    return new Client() as unknown as SshClientLike
}

function safeEnd(client: SshClientLike): void {
    try {
        client.end()
    } catch {
        // Closing is best-effort during pool cleanup and connection failure handling.
    }
}

function collectCommandOutput(
    channel: SshChannelLike,
    options: Required<SshExecOptions>,
    resolve: (value: SshExecResult) => void,
    reject: (error: Error) => void
): void {
    const stdout: Array<Buffer | string> = []
    const stderr: Array<Buffer | string> = []
    let exitCode: number | undefined
    let signal: string | undefined
    let settled = false

    const timeout = setTimeout(() => {
        settled = true
        closeChannel(channel)
        reject(new Error(`SSH command timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)

    channel.on("data", (chunk) => stdout.push(chunk))
    channel.stderr.on("data", (chunk) => stderr.push(chunk))
    channel.on("exit", (code: unknown, exitSignal: unknown) => {
        if (typeof code === "number") {
            exitCode = code
        }
        if (typeof exitSignal === "string") {
            signal = exitSignal
        }
    })
    channel.on("close", () => {
        if (settled) {
            return
        }

        settled = true
        clearTimeout(timeout)
        resolve(createExecResult(stdout, stderr, options.maxOutputBytes, options.encoding, exitCode, signal))
    })
    channel.on("error", (error: unknown) => {
        if (settled) {
            return
        }

        settled = true
        clearTimeout(timeout)
        reject(toError(error, "SSH command failed"))
    })
}

function createExecResult(
    stdout: Array<Buffer | string>,
    stderr: Array<Buffer | string>,
    maxOutputBytes: number,
    encoding: BufferEncoding,
    exitCode?: number,
    signal?: string
): SshExecResult {
    const stdoutOutput = truncateSshOutput(Buffer.concat(stdout.map((chunk) => Buffer.from(chunk))), maxOutputBytes, encoding)
    const stderrOutput = truncateSshOutput(Buffer.concat(stderr.map((chunk) => Buffer.from(chunk))), maxOutputBytes, encoding)

    return {
        stdout: stdoutOutput.text,
        stderr: stderrOutput.text,
        stdoutTruncated: stdoutOutput.truncated,
        stderrTruncated: stderrOutput.truncated,
        stdoutBytes: stdoutOutput.originalBytes,
        stderrBytes: stderrOutput.originalBytes,
        exitCode,
        signal,
    }
}

function closeChannel(channel: SshChannelLike): void {
    if (channel.close) {
        channel.close()
        return
    }

    channel.destroy?.()
}

function wrapSftpVoid(call: (callback: (err: Error | undefined) => void) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        call((error) => {
            if (error) {
                reject(error)
                return
            }

            resolve()
        })
    })
}

function toError(error: unknown, fallbackMessage: string): Error {
    if (error instanceof Error) {
        return error
    }

    if (typeof error === "string") {
        return new Error(error)
    }

    return new Error(fallbackMessage)
}

function defaultSshFailureInstruction(): string {
    return "Report the SSH failure and do not retry blindly unless SSH config, auth, or connectivity changed."
}
