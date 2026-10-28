#!/usr/bin/env node
import { Buffer } from "node:buffer"
import { realpathSync, writeSync } from "node:fs"
import { resolve } from "node:path"
import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { TextDecoder, types } from "node:util"
import { writePlaintextProfile } from "./credentials/provision"
import { createCredentialListingErrorResponse, formatCredentialListing } from "./credentials/listing"
import { createRuntimeCredentialResolver } from "./credentials/runtime"
import {
    CredentialError,
    MAX_CREDENTIAL_ENVELOPE_BYTES,
    MAX_CREDENTIAL_FIELD_BYTES,
    type CredentialErrorCode,
    type CredentialKind,
    type CredentialResolver,
} from "./credentials/types"
import { validateCredentialProfile } from "./credentials/validation"
import {
    getWindowsCredentialIdentity,
    writeWindowsProfile,
    type WindowsCredentialIdentity,
} from "./credentials/windows"
import { buildEnvVarName, normalizeEnvKey } from "./utils/envkey"

export type CredentialsCliInput = Readable & {
    readonly isTTY?: boolean
    readonly isRaw?: boolean
    setRawMode?: (mode: boolean) => unknown
}

export interface CredentialsCliOutput {
    readonly isTTY?: boolean
    write(text: string): void
}

export interface CredentialsCliDependencies {
    stdin?: CredentialsCliInput
    stdout?: CredentialsCliOutput
    stderr?: CredentialsCliOutput
    promptOutput?: CredentialsCliOutput
    env?: Readonly<Record<string, string | undefined>>
    platform?: NodeJS.Platform
    getWindowsCredentialIdentity?: typeof getWindowsCredentialIdentity
    writeWindowsProfile?: typeof writeWindowsProfile
    writePlaintextProfile?: typeof writePlaintextProfile
    credentialResolver?: CredentialResolver
}

type CliErrorReason = "usage" | "tty" | "sid" | "aborted"
type WriteProvider = "windows-credential-manager" | "plaintext"

interface WriteCommand {
    command: "set" | "import-env"
    provider: WriteProvider
    kind: CredentialKind
    id: string
    expectedSid?: string
    stdin: boolean
}

class CliError extends Error {
    constructor(readonly reason: CliErrorReason) {
        super(FAILURE_MESSAGE)
    }
}

const CONTEXT_GUIDANCE = "Warning: Run under the actual OpenCode service logon context; matching SID alone does not prove the same logon session."
const PLAINTEXT_WARNING = "Warning: Plaintext credentials are stored unencrypted at the fixed global credential path."
const FAILURE_MESSAGE = "Credential setup failed."
const CLI_ERROR_MESSAGES: Readonly<Record<CliErrorReason, string>> = {
    usage: "Invalid credentials command or options. Use --help.",
    tty: "Hidden input requires stdin and prompt output TTYs with working raw-mode support. Use --stdin instead.",
    sid: "Windows writes require a nonempty --expected-sid matching the current token.",
    aborted: "Credential setup aborted.",
}
const CREDENTIAL_ERROR_MESSAGES: Readonly<Record<CredentialErrorCode, string>> = {
    locked: "Credential store is locked.",
    denied: "Credential access or identity assertion denied.",
    invalid: "Invalid credential profile or ID.",
    unsafe_location: "Plaintext credentials require a private global configuration directory outside workspaces and Git repositories.",
    too_large: "Credential input exceeds the supported size limit.",
    failed: FAILURE_MESSAGE,
    missing: "Credential profile is missing.",
    incomplete: "Credential profile is incomplete.",
    unavailable: "Credential provider is unavailable.",
    unsupported: "Credential setup or identity assertion is unsupported on this platform.",
}
const HELP = `Usage:
  autocode-credentials identity
  autocode-credentials list
  autocode-credentials set --provider windows-credential-manager|plaintext --kind ssh|db|rest --key ID --expected-sid SID [--stdin]
  autocode-credentials import-env --provider windows-credential-manager|plaintext --kind ssh|db|rest --key ID --expected-sid SID

Windows writes require --expected-sid, checked before input and again at write time.
For non-Windows plaintext writes, omit --expected-sid. Linux native setup is not supported.
set prompts every field with hidden input; empty terminal fields are omitted.
--stdin accepts a raw UTF-8 profile JSON object, at most 65,536 bytes.
import-env reads only the selected profile's exact AUTOCODE environment keys.
stdin and environment input preserve explicit empty strings.
${PLAINTEXT_WARNING}
${CONTEXT_GUIDANCE}
`
const PROFILE_FIELDS: Readonly<Record<CredentialKind, readonly { name: string; label: string }[]>> = {
    ssh: [
        { name: "host", label: "Host (hidden): " },
        { name: "username", label: "Username (hidden): " },
        { name: "port", label: "Port (hidden): " },
        { name: "keyfile", label: "Keyfile (hidden): " },
        { name: "agent", label: "Agent (hidden): " },
        { name: "password", label: "Password (hidden): " },
        { name: "keypass", label: "Key passphrase (hidden): " },
    ],
    db: [
        { name: "connection", label: "Connection (hidden): " },
        { name: "username", label: "Username (hidden): " },
        { name: "password", label: "Password (hidden): " },
    ],
    rest: [
        { name: "authorization", label: "Authorization (hidden): " },
        { name: "username", label: "Username (hidden): " },
        { name: "password", label: "Password (hidden): " },
    ],
}

function parseCommand(args: readonly string[]): WriteCommand | "identity" | "list" | "help" {
    const command = args[0]
    const knownCommand = command === "identity" || command === "list" || command === "set" || command === "import-env"
    if ((args.length === 1 && (command === "--help" || command === "-h"))
        || (args.length === 2 && knownCommand && (args[1] === "--help" || args[1] === "-h"))) {
        return "help"
    }
    if (command === "identity" && args.length === 1) {
        return "identity"
    }
    if (command === "list" && args.length === 1) {
        return "list"
    }
    if (command !== "set" && command !== "import-env") {
        throw new CliError("usage")
    }

    const flags = new Map<string, string>()
    let stdin = false
    for (let index = 1; index < args.length; index++) {
        const flag = args[index]
        if (flag === "--stdin") {
            if (command !== "set" || stdin) throw new CliError("usage")
            stdin = true
            continue
        }
        if (flag !== "--provider" && flag !== "--kind" && flag !== "--key" && flag !== "--expected-sid") {
            throw new CliError("usage")
        }
        const value = args[++index]
        if (flags.has(flag) || value === undefined || value.startsWith("--")) {
            throw new CliError("usage")
        }
        flags.set(flag, value)
    }

    const provider = flags.get("--provider")
    const kind = flags.get("--kind")
    const key = flags.get("--key")
    if ((provider !== "windows-credential-manager" && provider !== "plaintext")
        || (kind !== "ssh" && kind !== "db" && kind !== "rest") || key === undefined) {
        throw new CliError("usage")
    }
    let id: string
    try {
        id = normalizeEnvKey(key, { allowHyphen: kind === "ssh" })
    } catch {
        throw new CredentialError("invalid")
    }
    return { command, provider, kind, id, expectedSid: flags.get("--expected-sid"), stdin }
}

function errorMessage(error: unknown): string {
    try {
        if (typeof error !== "object" || error === null || types.isProxy(error)) return FAILURE_MESSAGE
        if (error instanceof CliError) {
            const reason: unknown = Object.getOwnPropertyDescriptor(error, "reason")?.value
            if (typeof reason === "string" && Object.hasOwn(CLI_ERROR_MESSAGES, reason)) {
                return CLI_ERROR_MESSAGES[reason as CliErrorReason]
            }
        }
        if (error instanceof CredentialError) {
            const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value
            if (typeof code === "string" && Object.hasOwn(CREDENTIAL_ERROR_MESSAGES, code)) {
                return CREDENTIAL_ERROR_MESSAGES[code as CredentialErrorCode]
            }
        }
    } catch {
        // Error inspection must not expose untrusted messages or reflection failures.
    }
    return FAILURE_MESSAGE
}

function terminalOutput(stream: NodeJS.WriteStream): CredentialsCliOutput {
    if (!("fd" in stream) || typeof stream.fd !== "number") {
        throw new CredentialError("failed")
    }
    const fd = stream.fd
    return {
        isTTY: stream.isTTY,
        write(text: string): void {
            // Synchronous writes keep broken-pipe errors inside the sanitized runner.
            const bytes = Buffer.from(text, "utf8")
            let offset = 0
            while (offset < bytes.length) {
                const written = writeSync(fd, bytes, offset, bytes.length - offset)
                if (written <= 0) throw new CredentialError("failed")
                offset += written
            }
        },
    }
}

function inputBytes(chunk: unknown): Uint8Array {
    if (typeof chunk === "string") {
        if (chunk.length > MAX_CREDENTIAL_ENVELOPE_BYTES
            || Buffer.byteLength(chunk, "utf8") > MAX_CREDENTIAL_ENVELOPE_BYTES) {
            throw new CredentialError("too_large")
        }
        if (!chunk.isWellFormed()) throw new CredentialError("invalid")
        return Buffer.from(chunk, "utf8")
    }
    if (!types.isUint8Array(chunk)) throw new CredentialError("invalid")
    if (chunk.byteLength > MAX_CREDENTIAL_ENVELOPE_BYTES) throw new CredentialError("too_large")
    return chunk
}

function decodeUtf8(decoder: TextDecoder, bytes?: Uint8Array, stream: boolean = false): string {
    try {
        return decoder.decode(bytes, { stream })
    } catch {
        throw new CredentialError("invalid")
    }
}

async function consumeInput(input: CredentialsCliInput, consume: (chunk: unknown) => boolean): Promise<void> {
    // Predecoded streams can silently replace malformed UTF-8 before validation.
    if (typeof input.readableEncoding === "string") throw new CredentialError("invalid")
    await new Promise<void>((resolveRead: () => void, rejectRead: (reason?: unknown) => void): void => {
        let settled = false
        const finish = (error?: unknown): void => {
            if (settled) return
            settled = true
            input.removeListener("data", onData)
            input.removeListener("end", onEnd)
            input.removeListener("close", onClose)
            input.removeListener("error", onError)
            process.removeListener("SIGINT", onAbort)
            process.removeListener("SIGTERM", onAbort)
            process.removeListener("SIGHUP", onAbort)
            try {
                input.pause()
            } catch {
                rejectRead(new CredentialError("failed"))
                return
            }
            if (error === undefined) resolveRead()
            else rejectRead(error)
        }
        const onData = (chunk: unknown): void => {
            if (settled) return
            try {
                if (consume(chunk)) finish()
            } catch (error: unknown) {
                finish(error)
            }
        }
        const onEnd = (): void => finish()
        const onClose = (): void => finish(new CliError("aborted"))
        const onError = (_error: unknown): void => finish(new CredentialError("failed"))
        const onAbort = (): void => finish(new CliError("aborted"))
        try {
            if (input.readableEnded) {
                finish()
                return
            }
            if (input.destroyed || input.errored) {
                finish(new CliError("aborted"))
                return
            }
            input.on("error", onError)
            input.on("end", onEnd)
            input.on("close", onClose)
            process.on("SIGINT", onAbort)
            process.on("SIGTERM", onAbort)
            process.on("SIGHUP", onAbort)
            input.on("data", onData)
            if (!settled) input.resume()
        } catch (error: unknown) {
            finish(error)
        }
    })
}

async function readStdinProfile(input: CredentialsCliInput): Promise<unknown> {
    const storage = Buffer.alloc(MAX_CREDENTIAL_ENVELOPE_BYTES)
    let size = 0
    try {
        await consumeInput(input, (chunk: unknown): boolean => {
            const bytes = inputBytes(chunk)
            if (bytes.byteLength > storage.length - size) throw new CredentialError("too_large")
            storage.set(bytes, size)
            size += bytes.byteLength
            return false
        })
        const text = decodeUtf8(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }), storage.subarray(0, size))
        try {
            const profile: unknown = JSON.parse(text)
            return profile
        } catch {
            throw new CredentialError("invalid")
        }
    } finally {
        storage.fill(0)
    }
}

async function readHiddenProfile(
    kind: CredentialKind,
    input: CredentialsCliInput,
    output: CredentialsCliOutput,
): Promise<Record<string, string>> {
    const setRawMode = input.setRawMode
    if (input.isTTY !== true || output.isTTY !== true || typeof setRawMode !== "function") {
        throw new CliError("tty")
    }
    const previousRawMode = input.isRaw === true
    const fields = PROFILE_FIELDS[kind]
    const profile: Record<string, string> = Object.create(null)
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    let index = 0
    let value = ""
    let fieldBytes = 0
    let totalBytes = 0
    let skipLineFeed = false
    input.pause()
    try {
        setRawMode.call(input, true)
        if (input.isRaw !== true) throw new CliError("tty")
        output.write(fields[index].label)
        await consumeInput(input, (chunk: unknown): boolean => {
            const bytes = inputBytes(chunk)
            totalBytes += bytes.byteLength
            if (totalBytes > MAX_CREDENTIAL_ENVELOPE_BYTES) throw new CredentialError("too_large")
            const text = decodeUtf8(decoder, bytes, true)
            for (const character of text) {
                if (character === "\x03" || character === "\x04" || character === "\x1a") {
                    throw new CliError("aborted")
                }
                if (skipLineFeed) {
                    skipLineFeed = false
                    if (character === "\n") continue
                }
                if (index === fields.length) throw new CredentialError("invalid")
                if (character === "\r" || character === "\n") {
                    if (value.length > 0) profile[fields[index].name] = value
                    value = ""
                    fieldBytes = 0
                    index++
                    skipLineFeed = character === "\r"
                    output.write("\n")
                    if (index < fields.length) output.write(fields[index].label)
                    continue
                }
                if (character === "\b" || character === "\x7f") {
                    const last = value.charCodeAt(value.length - 1)
                    const width = last >= 0xdc00 && last <= 0xdfff ? 2 : 1
                    fieldBytes -= Buffer.byteLength(value.slice(-width), "utf8")
                    value = value.slice(0, Math.max(0, value.length - width))
                    continue
                }
                if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(character)) {
                    throw new CredentialError("invalid")
                }
                fieldBytes += Buffer.byteLength(character, "utf8")
                if (fieldBytes > MAX_CREDENTIAL_FIELD_BYTES) throw new CredentialError("too_large")
                value += character
            }
            return index === fields.length
        })
        decodeUtf8(decoder)
        if (index !== fields.length) throw new CliError("aborted")
        return profile
    } finally {
        try {
            input.pause()
        } finally {
            setRawMode.call(input, previousRawMode)
        }
    }
}

function importEnvironmentProfile(
    command: WriteCommand,
    environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
    const profile: Record<string, string> = Object.create(null)
    let totalBytes = 0
    for (const field of PROFILE_FIELDS[command.kind]) {
        const key = buildEnvVarName(`AUTOCODE_${command.kind.toUpperCase()}`, command.id, field.name.toUpperCase())
        if (!Object.hasOwn(environment, key)) continue
        const value = environment[key]
        if (value === undefined) continue
        if (typeof value !== "string") throw new CredentialError("invalid")
        const size = Buffer.byteLength(value, "utf8")
        totalBytes += size
        if (size > MAX_CREDENTIAL_FIELD_BYTES || totalBytes > MAX_CREDENTIAL_ENVELOPE_BYTES) {
            throw new CredentialError("too_large")
        }
        profile[field.name] = value
    }
    return profile
}

function checkedIdentity(identity: WindowsCredentialIdentity): WindowsCredentialIdentity {
    if (typeof identity !== "object" || identity === null
        || typeof identity.sid !== "string" || identity.sid.length === 0
        || typeof identity.account !== "string" || identity.account.length === 0
        || Buffer.byteLength(identity.sid, "utf8") > MAX_CREDENTIAL_FIELD_BYTES
        || Buffer.byteLength(identity.account, "utf8") > MAX_CREDENTIAL_FIELD_BYTES
        || /[\x00-\x1f\x7f-\x9f]/u.test(identity.sid)
        || /[\x00-\x1f\x7f-\x9f]/u.test(identity.account)) {
        throw new CredentialError("failed")
    }
    return identity
}

async function preflightWrite(
    command: WriteCommand,
    platform: NodeJS.Platform,
    identity: typeof getWindowsCredentialIdentity,
    output: CredentialsCliOutput,
): Promise<void> {
    if (platform === "win32" || command.provider === "windows-credential-manager") {
        output.write(`${CONTEXT_GUIDANCE}\n`)
    }
    if (command.provider === "windows-credential-manager" && platform !== "win32") {
        throw new CredentialError("unsupported")
    }
    if (platform !== "win32") {
        if (command.expectedSid !== undefined) throw new CredentialError("unsupported")
        return
    }
    if (command.expectedSid === undefined || command.expectedSid.trim().length === 0) {
        throw new CliError("sid")
    }
    const current = checkedIdentity(await identity({ expectedSid: command.expectedSid }))
    if (current.sid !== command.expectedSid) throw new CredentialError("denied")
}

export async function runCredentialsCli(
    args: readonly string[],
    dependencies: CredentialsCliDependencies = {},
): Promise<number> {
    let errorOutput: CredentialsCliOutput | undefined
    try {
        const stdout = dependencies.stdout ?? terminalOutput(process.stdout)
        const stderr = dependencies.stderr ?? terminalOutput(process.stderr)
        errorOutput = stderr
        const command = parseCommand(args)
        if (command === "help") {
            stdout.write(HELP)
            return 0
        }
        if (command === "list") {
            const credentialResolver = dependencies.credentialResolver ?? createRuntimeCredentialResolver()
            try {
                stdout.write(`${await formatCredentialListing(credentialResolver)}\n`)
                return 0
            } catch {
                try {
                    stderr.write(`${createCredentialListingErrorResponse()}\n`)
                } catch {
                    // Error output failures must not expose the original provider failure.
                }
                return 1
            }
        }
        const platform = dependencies.platform ?? process.platform
        const identity = dependencies.getWindowsCredentialIdentity ?? getWindowsCredentialIdentity
        if (command === "identity") {
            if (platform !== "win32") throw new CredentialError("unsupported")
            const current = checkedIdentity(await identity())
            stdout.write(`SID: ${current.sid}\nAccount: ${current.account}\n${CONTEXT_GUIDANCE}\n`)
            return 0
        }

        await preflightWrite(command, platform, identity, stderr)
        if (command.provider === "plaintext") stderr.write(`${PLAINTEXT_WARNING}\n`)
        let profile: unknown
        if (command.command === "import-env") {
            profile = importEnvironmentProfile(command, dependencies.env ?? process.env)
        } else {
            const input = dependencies.stdin ?? process.stdin
            profile = command.stdin
                ? await readStdinProfile(input)
                : await readHiddenProfile(command.kind, input, dependencies.promptOutput ?? stderr)
        }
        const validation = validateCredentialProfile(command.kind, profile)
        if (validation.status !== "found") throw new CredentialError("incomplete")
        const options = { expectedSid: command.expectedSid }
        if (command.provider === "windows-credential-manager") {
            await (dependencies.writeWindowsProfile ?? writeWindowsProfile)(command.kind, command.id, validation.profile, options)
        } else {
            await (dependencies.writePlaintextProfile ?? writePlaintextProfile)(command.kind, command.id, validation.profile, options)
        }
        stdout.write("Credential profile saved.\n")
        return 0
    } catch (error: unknown) {
        try {
            (errorOutput ?? terminalOutput(process.stderr)).write(`${errorMessage(error)}\n`)
        } catch {
            // An unavailable error stream must not turn failures into uncaught exceptions.
        }
        return 1
    }
}

function isDirectEntry(): boolean {
    try {
        const entry = process.argv[1]
        if (entry === undefined) return false
        const entryPath = entry.startsWith("file:") ? fileURLToPath(new URL(entry)) : resolve(entry)
        const currentPath = realpathSync(fileURLToPath(import.meta.url))
        const invokedPath = realpathSync(entryPath)
        return process.platform === "win32"
            ? currentPath.toLowerCase() === invokedPath.toLowerCase()
            : currentPath === invokedPath
    } catch {
        return false
    }
}

if (isDirectEntry()) {
    process.exitCode = await runCredentialsCli(process.argv.slice(2))
}
