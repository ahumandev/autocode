import { randomBytes, randomUUID } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises"
import { posix, win32 } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { TextDecoder, types } from "node:util"
import { parseTree, type Node, type ParseError } from "jsonc-parser/lib/esm/main.js"
import { normalizeEnvKey } from "../utils/envkey"
import {
    MAX_PLAINTEXT_STORE_BYTES,
    parsePlaintextCredentialStore,
    readPlaintextCredentialStore,
    resolvePlaintextCredentialStorePath,
    serializePlaintextCredentialStore,
    type PlaintextCredentialOptions,
    type PlaintextCredentialStore,
    type PlaintextCredentialStoreReadResult,
} from "./plaintext"
import { CredentialError, type CredentialKind } from "./types"
import { validateCredentialProfile } from "./validation"
import { readSecureWindowsFile, writeSecureWindowsFile, type SecureWindowsFileReadResult } from "./windows-files"

export const PLAINTEXT_PROVISION_LOCK_FILENAME = ".profiles.lock"
export const PLAINTEXT_PROVISION_INITIALIZER_PREFIX = ".i"

export type PlaintextProfileWriteGuard =
    | { kind: CredentialKind; id: string; status: "missing" }
    | { kind: CredentialKind; id: string; status: "found"; profile: unknown }

export class PlaintextProfilePreconditionError extends CredentialError {
    constructor(readonly reason: "changed" | "drift") {
        super("failed")
        this.name = "PlaintextProfilePreconditionError"
    }
}

const path = process.platform === "win32" ? win32 : posix
const LOCK_WAIT_MS = 30000
const INITIAL_LOCK_BACKOFF_MS = 25
const MAX_LOCK_BACKOFF_MS = 250
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const PERMISSION_MASK = 0o7777
const provisionGates = new Map<string, Promise<void>>()

function readErrorCode(error: unknown): unknown {
    try {
        if (typeof error === "object" && error !== null && !types.isProxy(error)) {
            const descriptor = Object.getOwnPropertyDescriptor(error, "code")
            if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) {
                return descriptor.value
            }
        }
    } catch {
        // Error reflection must not expose untrusted values.
    }
    return undefined
}

function sanitizeProvisionError(error: unknown): CredentialError {
    try {
        const code = readErrorCode(error)
        if (typeof error === "object" && error !== null && !types.isProxy(error) && error instanceof CredentialError) {
            if (error instanceof PlaintextProfilePreconditionError) {
                const reason = Object.getOwnPropertyDescriptor(error, "reason")?.value
                if (reason === "changed" || reason === "drift") {
                    return new PlaintextProfilePreconditionError(reason)
                }
            }
            switch (code) {
                case "locked":
                case "denied":
                case "invalid":
                case "unsafe_location":
                case "too_large":
                case "failed":
                case "missing":
                case "incomplete":
                case "unavailable":
                case "unsupported":
                    return new CredentialError(code)
            }
        }
        switch (code) {
            case "EACCES":
            case "EPERM":
            case "EROFS":
            case "ELOOP":
                return new CredentialError("denied")
            case "EBUSY":
            case "EAGAIN":
            case "ETXTBSY":
                return new CredentialError("locked")
        }
    } catch {
        // Untrusted error prototypes can also fail inspection.
    }
    return new CredentialError("failed")
}

function copyProvisionOptions(options: PlaintextCredentialOptions | undefined): PlaintextCredentialOptions {
    const copy: PlaintextCredentialOptions = Object.create(null)
    if (options === undefined) {
        return copy
    }
    if (typeof options !== "object" || options === null || Array.isArray(options) || types.isProxy(options)) {
        throw new CredentialError("invalid")
    }
    const prototype: unknown = Object.getPrototypeOf(options)
    if (prototype !== Object.prototype && prototype !== null) {
        throw new CredentialError("invalid")
    }
    for (const key of Reflect.ownKeys(options)) {
        if (key !== "globalConfigRoot" && key !== "expectedSid") {
            throw new CredentialError("invalid")
        }
        const descriptor = Object.getOwnPropertyDescriptor(options, key)
        if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
            throw new CredentialError("invalid")
        }
        const value: unknown = descriptor.value
        if (value !== undefined && typeof value !== "string") {
            throw new CredentialError("invalid")
        }
        copy[key] = value
    }
    return copy
}

function normalizeProfileId(kind: CredentialKind, id: string): string {
    if ((kind !== "ssh" && kind !== "db" && kind !== "rest") || typeof id !== "string") {
        throw new CredentialError("invalid")
    }
    try {
        return normalizeEnvKey(id, { allowHyphen: kind === "ssh" })
    } catch {
        throw new CredentialError("invalid")
    }
}

type PreparedPlaintextGuard = { status: "missing" } | { status: "found"; record: string }

function canonicalProfile(kind: CredentialKind, profile: unknown): string {
    const validation = validateCredentialProfile(kind, profile)
    if (validation.status !== "found") {
        throw new CredentialError("incomplete")
    }
    const fields = validation.profile as unknown as Record<string, string>
    return JSON.stringify(Object.keys(fields).sort().map((key: string): [string, string] => [key, fields[key]]))
}

function preparePlaintextGuard(kind: CredentialKind, id: string, guard: PlaintextProfileWriteGuard | undefined): PreparedPlaintextGuard | undefined {
    if (guard === undefined) return undefined
    if (typeof guard !== "object" || guard === null || Array.isArray(guard) || types.isProxy(guard)) {
        throw new CredentialError("invalid")
    }
    const prototype: unknown = Object.getPrototypeOf(guard)
    if (prototype !== Object.prototype && prototype !== null) throw new CredentialError("invalid")
    const values: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(guard)) {
        if (typeof key !== "string" || !["kind", "id", "status", "profile"].includes(key)) throw new CredentialError("invalid")
        const descriptor = Object.getOwnPropertyDescriptor(guard, key)
        if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new CredentialError("invalid")
        values[key] = descriptor.value
    }
    if (values.kind !== kind || values.id !== id) throw new CredentialError("invalid")
    if (values.status === "missing" && !Object.hasOwn(values, "profile")) return { status: "missing" }
    if (values.status === "found" && Object.hasOwn(values, "profile")) {
        return { status: "found", record: canonicalProfile(kind, values.profile) }
    }
    throw new CredentialError("invalid")
}

function checkPlaintextGuard(kind: CredentialKind, id: string, profiles: Record<string, unknown>, guard: PreparedPlaintextGuard): void {
    for (const storedId of Object.keys(profiles)) {
        if (storedId !== id && normalizeProfileId(kind, storedId) === id) {
            throw new PlaintextProfilePreconditionError("drift")
        }
    }
    const exists = Object.hasOwn(profiles, id)
    if (guard.status === "missing") {
        if (exists) throw new PlaintextProfilePreconditionError("changed")
        return
    }
    if (!exists) throw new PlaintextProfilePreconditionError("changed")
    let record: string
    try {
        record = canonicalProfile(kind, profiles[id])
    } catch {
        throw new PlaintextProfilePreconditionError("drift")
    }
    if (record !== guard.record) throw new PlaintextProfilePreconditionError("changed")
}

async function withProvisionGate(storePath: string, operation: () => Promise<void>): Promise<void> {
    const key = process.platform === "win32" ? storePath.toLowerCase() : storePath
    const previous = provisionGates.get(key) ?? Promise.resolve()
    let release: () => void = (): void => {}
    const current = new Promise<void>((resolve: () => void): void => {
        release = resolve
    })
    provisionGates.set(key, current)
    try {
        await previous
        await operation()
    } finally {
        release()
        if (provisionGates.get(key) === current) {
            provisionGates.delete(key)
        }
    }
}

async function acquireProvisionLock(lockPath: string): Promise<FileHandle> {
    const deadline = performance.now() + LOCK_WAIT_MS
    let backoff = INITIAL_LOCK_BACKOFF_MS
    for (;;) {
        try {
            // Windows privacy comes from the helper-protected parent DACL, not this POSIX mode.
            return await open(lockPath, "wx", PRIVATE_FILE_MODE)
        } catch (error: unknown) {
            if (readErrorCode(error) !== "EEXIST") {
                throw error
            }
        }
        const remaining = deadline - performance.now()
        if (remaining <= 0) {
            throw new CredentialError("locked")
        }
        await delay(Math.min(backoff, remaining))
        backoff = Math.min(backoff * 2, MAX_LOCK_BACKOFF_MS)
    }
}

async function releaseOwnedFile(filePath: string, file: FileHandle): Promise<void> {
    let failure: CredentialError | undefined
    try {
        const owned = await file.stat({ bigint: true })
        const current = await lstat(filePath, { bigint: true })
        // The open handle pins identity; never unlink a replacement lock or temporary file.
        if (!current.isFile() || current.nlink !== 1n || current.dev !== owned.dev || current.ino !== owned.ino) {
            throw new CredentialError("failed")
        }
        await unlink(filePath)
    } catch (error: unknown) {
        if (readErrorCode(error) !== "ENOENT") {
            failure = sanitizeProvisionError(error)
        }
    } finally {
        try {
            await file.close()
        } catch (error: unknown) {
            failure ??= sanitizeProvisionError(error)
        }
    }
    if (failure !== undefined) {
        throw failure
    }
}

async function preparePrivatePosixParent(parent: string): Promise<void> {
    if (typeof process.getuid !== "function") {
        throw new CredentialError("unsupported")
    }
    const uid = process.getuid()
    const directories: string[] = []
    let current = parent
    for (;;) {
        directories.push(current)
        const ancestor = path.dirname(current)
        if (ancestor === current) {
            break
        }
        current = ancestor
    }
    for (const directory of directories.reverse()) {
        try {
            await lstat(directory)
        } catch (error: unknown) {
            if (readErrorCode(error) !== "ENOENT") {
                throw error
            }
            try {
                await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE })
            } catch (creationError: unknown) {
                if (readErrorCode(creationError) !== "EEXIST") {
                    throw creationError
                }
            }
        }
        const metadata = await lstat(directory)
        if (metadata.isSymbolicLink() || !metadata.isDirectory()
            || (directory === parent && (metadata.uid !== uid
                || (metadata.mode & PERMISSION_MASK) !== PRIVATE_DIRECTORY_MODE))) {
            throw new CredentialError("denied")
        }
    }
}

async function writePrivatePosixStore(storePath: string, contents: string): Promise<void> {
    const temporaryPath = path.join(path.dirname(storePath), `.profiles-${randomUUID()}.tmp`)
    const file = await open(temporaryPath, "wx", PRIVATE_FILE_MODE)
    let committed = false
    let failure: CredentialError | undefined
    try {
        const metadata = await file.stat()
        if (typeof process.getuid !== "function" || metadata.uid !== process.getuid()
            || (metadata.mode & PERMISSION_MASK) !== PRIVATE_FILE_MODE || metadata.nlink !== 1) {
            throw new CredentialError("denied")
        }
        await file.writeFile(contents, "utf8")
        await file.sync()
        await rename(temporaryPath, storePath)
        committed = true
    } catch (error: unknown) {
        failure = sanitizeProvisionError(error)
    } finally {
        try {
            if (committed) {
                await file.close()
            } else {
                await releaseOwnedFile(temporaryPath, file)
            }
        } catch (error: unknown) {
            failure ??= sanitizeProvisionError(error)
        }
    }
    if (failure !== undefined) {
        throw failure
    }
}

async function inspectGuardedPosixFile(storePath: string, uid: number): Promise<BigIntStats | undefined> {
    const ancestors: string[] = []
    let current = storePath
    for (;;) {
        ancestors.push(current)
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
    }
    for (const entry of ancestors.reverse()) {
        let metadata: BigIntStats
        try {
            metadata = await lstat(entry, { bigint: true })
        } catch (error: unknown) {
            if (entry === storePath && readErrorCode(error) === "ENOENT") return undefined
            throw error
        }
        if (metadata.isSymbolicLink() || (entry !== storePath && !metadata.isDirectory())) throw new CredentialError("denied")
        if (entry === path.dirname(storePath)
            && (metadata.uid !== BigInt(uid) || (metadata.mode & BigInt(PERMISSION_MASK)) !== BigInt(PRIVATE_DIRECTORY_MODE))) {
            throw new CredentialError("denied")
        }
        if (entry === storePath) {
            if (!metadata.isFile() || metadata.uid !== BigInt(uid) || metadata.nlink !== 1n
                || (metadata.mode & BigInt(PERMISSION_MASK)) !== BigInt(PRIVATE_FILE_MODE)) throw new CredentialError("denied")
            return metadata
        }
    }
    throw new CredentialError("failed")
}

function sameGuardedFile(left: BigIntStats, right: BigIntStats): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size
        && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
        && left.uid === right.uid && left.mode === right.mode && left.nlink === right.nlink
}

async function readGuardedPosixFile(storePath: string): Promise<SecureWindowsFileReadResult> {
    if (typeof process.getuid !== "function") throw new CredentialError("unsupported")
    const uid = process.getuid()
    const before = await inspectGuardedPosixFile(storePath, uid)
    if (before === undefined) return { status: "missing" }
    if (before.size > BigInt(MAX_PLAINTEXT_STORE_BYTES)) throw new CredentialError("too_large")
    const file = await open(storePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
        const opened = await file.stat({ bigint: true })
        if (!sameGuardedFile(before, opened)) throw new CredentialError("denied")
        const bytes = Buffer.alloc(MAX_PLAINTEXT_STORE_BYTES + 1)
        let length = 0
        while (length < bytes.length) {
            const result = await file.read(bytes, length, bytes.length - length, length)
            if (result.bytesRead === 0) break
            length += result.bytesRead
        }
        if (length > MAX_PLAINTEXT_STORE_BYTES) throw new CredentialError("too_large")
        const after = await inspectGuardedPosixFile(storePath, uid)
        const finalHandle = await file.stat({ bigint: true })
        if (after === undefined || !sameGuardedFile(opened, after) || !sameGuardedFile(opened, finalHandle)
            || BigInt(length) !== opened.size) throw new CredentialError("denied")
        return { status: "found", contents: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)) }
    } finally {
        await file.close()
    }
}

function assertUnambiguousJson(contents: string): void {
    const errors: ParseError[] = []
    const root = parseTree(contents, errors, { disallowComments: true, allowTrailingComma: false })
    if (root === undefined || errors.length !== 0) throw new CredentialError("invalid")
    const pending: Node[] = [root]
    while (pending.length !== 0) {
        const node = pending.pop()
        if (node === undefined) throw new CredentialError("invalid")
        if (node.type === "object") {
            const keys = new Set<string>()
            for (const property of node.children ?? []) {
                const key = property.children?.[0]
                if (property.type !== "property" || property.children?.length !== 2
                    || key?.type !== "string" || typeof key.value !== "string" || keys.has(key.value)) {
                    throw new CredentialError("invalid")
                }
                keys.add(key.value)
            }
        }
        if (node.children !== undefined) {
            for (const child of node.children) pending.push(child)
        }
    }
}

async function readGuardedPlaintextStore(options: PlaintextCredentialOptions): Promise<PlaintextCredentialStoreReadResult> {
    try {
        const storePath = await resolvePlaintextCredentialStorePath(options)
        const raw = process.platform === "win32"
            ? await readSecureWindowsFile(storePath, MAX_PLAINTEXT_STORE_BYTES, { expectedSid: options.expectedSid })
            : await readGuardedPosixFile(storePath)
        if (raw.status === "missing") return raw
        assertUnambiguousJson(raw.contents)
        return { status: "found", store: parsePlaintextCredentialStore(raw.contents) }
    } catch {
        throw new PlaintextProfilePreconditionError("drift")
    }
}

export async function writePlaintextProfile<K extends CredentialKind>(
    kind: K,
    id: string,
    profile: unknown,
    options?: PlaintextCredentialOptions,
    guard?: PlaintextProfileWriteGuard,
): Promise<void> {
    try {
        const normalizedId = normalizeProfileId(kind, id)
        const validation = validateCredentialProfile(kind, profile)
        if (validation.status === "incomplete") {
            throw new CredentialError("incomplete")
        }
        const settings = copyProvisionOptions(options)
        const precondition = preparePlaintextGuard(kind, normalizedId, guard)
        const storePath = await resolvePlaintextCredentialStorePath(settings)
        const parent = path.dirname(storePath)
        const pinnedOptions: PlaintextCredentialOptions = {
            globalConfigRoot: path.dirname(parent),
            expectedSid: settings.expectedSid,
        }
        await withProvisionGate(storePath, async (): Promise<void> => {
            await resolvePlaintextCredentialStorePath(pinnedOptions)
            if (process.platform === "win32") {
                // Unique names avoid cross-process replacement collisions before the store lock exists.
                const initializerPath = path.join(parent, `${PLAINTEXT_PROVISION_INITIALIZER_PREFIX}${randomBytes(8).toString("base64url")}`)
                let initialized = false
                try {
                    await writeSecureWindowsFile(initializerPath, "", 1, { expectedSid: settings.expectedSid })
                    initialized = true
                } finally {
                    if (initialized) {
                        const initializer = await open(initializerPath, "r")
                        await releaseOwnedFile(initializerPath, initializer)
                    }
                }
            } else {
                if (settings.expectedSid !== undefined) {
                    throw new CredentialError("unsupported")
                }
                await preparePrivatePosixParent(parent)
            }

            const lockPath = path.join(parent, PLAINTEXT_PROVISION_LOCK_FILENAME)
            const lock = await acquireProvisionLock(lockPath)
            let failure: CredentialError | undefined
            try {
                const result = precondition === undefined
                    ? await readPlaintextCredentialStore(pinnedOptions)
                    : await readGuardedPlaintextStore(pinnedOptions)
                const store: PlaintextCredentialStore = result.status === "missing"
                    ? { version: 1, profiles: Object.create(null) }
                    : result.store
                const profiles: Record<string, unknown> = store.profiles[kind] ?? Object.create(null)
                if (precondition !== undefined) checkPlaintextGuard(kind, normalizedId, profiles, precondition)
                profiles[normalizedId] = validation.profile
                Object.defineProperty(store.profiles, kind, {
                    value: profiles,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                })
                const contents = serializePlaintextCredentialStore(store)
                await resolvePlaintextCredentialStorePath(pinnedOptions)
                if (process.platform === "win32") {
                    await writeSecureWindowsFile(storePath, contents, MAX_PLAINTEXT_STORE_BYTES, { expectedSid: settings.expectedSid })
                } else {
                    await writePrivatePosixStore(storePath, contents)
                }
            } catch (error: unknown) {
                failure = sanitizeProvisionError(error)
            } finally {
                try {
                    await releaseOwnedFile(lockPath, lock)
                } catch (error: unknown) {
                    failure ??= sanitizeProvisionError(error)
                }
            }
            if (failure !== undefined) {
                throw failure
            }
        })
    } catch (error: unknown) {
        throw sanitizeProvisionError(error)
    }
}
