import { randomBytes, randomUUID } from "node:crypto"
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises"
import { posix, win32 } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { types } from "node:util"
import { normalizeEnvKey } from "../utils/envkey"
import {
    MAX_PLAINTEXT_STORE_BYTES,
    readPlaintextCredentialStore,
    resolvePlaintextCredentialStorePath,
    serializePlaintextCredentialStore,
    type PlaintextCredentialOptions,
    type PlaintextCredentialStore,
} from "./plaintext"
import { CredentialError, type CredentialKind } from "./types"
import { validateCredentialProfile } from "./validation"
import { writeSecureWindowsFile } from "./windows-files"

export const PLAINTEXT_PROVISION_LOCK_FILENAME = ".profiles.lock"
export const PLAINTEXT_PROVISION_INITIALIZER_PREFIX = ".i"

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

export async function writePlaintextProfile<K extends CredentialKind>(
    kind: K,
    id: string,
    profile: unknown,
    options?: PlaintextCredentialOptions,
): Promise<void> {
    try {
        const normalizedId = normalizeProfileId(kind, id)
        const validation = validateCredentialProfile(kind, profile)
        if (validation.status === "incomplete") {
            throw new CredentialError("incomplete")
        }
        const settings = copyProvisionOptions(options)
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
                const result = await readPlaintextCredentialStore(pinnedOptions)
                const store: PlaintextCredentialStore = result.status === "missing"
                    ? { version: 1, profiles: Object.create(null) }
                    : result.store
                const profiles: Record<string, unknown> = store.profiles[kind] ?? Object.create(null)
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
