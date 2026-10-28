import { Buffer } from "node:buffer"
import { constants, type Stats } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { posix, win32 } from "node:path"
import { TextDecoder, types } from "node:util"
import { normalizeEnvKey } from "../utils/envkey"
import { resolveOpenCodePaths } from "../utils/paths"
import {
    CredentialError,
    type CredentialErrorCode,
    type CredentialKind,
    type CredentialProfileInput,
    type CredentialProvider,
    type CredentialReadResult,
} from "./types"
import { serializeCredentialEnvelope } from "./validation"
import { readSecureWindowsFile, type SecureWindowsFileReadResult } from "./windows-files"

export interface PlaintextCredentialOptions {
    globalConfigRoot?: string
    expectedSid?: string
}

export const MAX_PLAINTEXT_STORE_BYTES = 1048576

export interface PlaintextCredentialStore {
    version: 1
    profiles: {
        ssh?: Record<string, CredentialProfileInput<"ssh">>
        db?: Record<string, CredentialProfileInput<"db">>
        rest?: Record<string, CredentialProfileInput<"rest">>
    }
}

export type PlaintextCredentialStoreReadResult =
    | { status: "found"; store: PlaintextCredentialStore }
    | { status: "missing" }

const path = process.platform === "win32" ? win32 : posix
const MAX_WINDOWS_PATH_LENGTH = 259
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const PERMISSION_MASK = 0o7777

function readOwnDataValue(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new CredentialError("invalid")
    }
    return descriptor.value
}

function copyDataObject(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) {
        throw new CredentialError("invalid")
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
        throw new CredentialError("invalid")
    }

    const copy: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") {
            throw new CredentialError("invalid")
        }
        copy[key] = readOwnDataValue(value, key)
    }
    return copy
}

function readErrorCode(error: unknown): unknown {
    try {
        if (typeof error === "object" && error !== null && !types.isProxy(error)) {
            const descriptor = Object.getOwnPropertyDescriptor(error, "code")
            if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) {
                return descriptor.value
            }
        }
    } catch {
        // Untrusted errors must not expose reflection failures.
    }
    return undefined
}

function sanitizePlaintextError(error: unknown, fallback: CredentialErrorCode = "failed"): CredentialError {
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
        // Error prototypes are not trusted input either.
    }
    return new CredentialError(fallback)
}

function readOptions(options: PlaintextCredentialOptions | undefined): PlaintextCredentialOptions {
    if (options === undefined) {
        return {}
    }
    const fields = copyDataObject(options)
    if (Object.keys(fields).some((key: string): boolean => key !== "globalConfigRoot" && key !== "expectedSid")
        || (fields.globalConfigRoot !== undefined && typeof fields.globalConfigRoot !== "string")
        || (fields.expectedSid !== undefined && typeof fields.expectedSid !== "string")) {
        throw new CredentialError("invalid")
    }
    return { globalConfigRoot: fields.globalConfigRoot, expectedSid: fields.expectedSid }
}

function assertCredentialKind(kind: unknown): asserts kind is CredentialKind {
    if (kind !== "ssh" && kind !== "db" && kind !== "rest") {
        throw new CredentialError("invalid")
    }
}

function assertNormalizedCredentialId(kind: CredentialKind, id: unknown): asserts id is string {
    if (typeof id !== "string" || id !== normalizeEnvKey(id, { allowHyphen: kind === "ssh" })) {
        throw new CredentialError("invalid")
    }
}

function copyProfiles<K extends CredentialKind>(kind: K, value: unknown): Record<string, CredentialProfileInput<K>> {
    const source = copyDataObject(value)
    const profiles: Record<string, CredentialProfileInput<K>> = Object.create(null)
    for (const id of Object.keys(source)) {
        assertNormalizedCredentialId(kind, id)
        const fields = copyDataObject(source[id])
        // Shared serialization enforces raw fields and the full envelope limit without requiring completeness.
        serializeCredentialEnvelope(kind, fields)
        profiles[id] = fields as CredentialProfileInput<K>
    }
    return profiles
}

function copyPlaintextCredentialStore(value: unknown): PlaintextCredentialStore {
    const source = copyDataObject(value)
    if (Object.keys(source).length !== 2 || source.version !== 1 || !Object.hasOwn(source, "profiles")) {
        throw new CredentialError("invalid")
    }
    const profiles = copyDataObject(source.profiles)
    for (const kind of Object.keys(profiles)) {
        assertCredentialKind(kind)
    }

    const store: PlaintextCredentialStore = Object.create(null)
    store.version = 1
    store.profiles = Object.create(null)
    if (Object.hasOwn(profiles, "ssh")) {
        store.profiles.ssh = copyProfiles("ssh", profiles.ssh)
    }
    if (Object.hasOwn(profiles, "db")) {
        store.profiles.db = copyProfiles("db", profiles.db)
    }
    if (Object.hasOwn(profiles, "rest")) {
        store.profiles.rest = copyProfiles("rest", profiles.rest)
    }
    return store
}

function assertStoreByteSize(contents: string): void {
    if (Buffer.byteLength(contents, "utf8") > MAX_PLAINTEXT_STORE_BYTES) {
        throw new CredentialError("too_large")
    }
}

export function parsePlaintextCredentialStore(contents: string): PlaintextCredentialStore {
    try {
        if (typeof contents !== "string") {
            throw new CredentialError("invalid")
        }
        assertStoreByteSize(contents)
        const store: unknown = JSON.parse(contents)
        return copyPlaintextCredentialStore(store)
    } catch (error: unknown) {
        throw sanitizePlaintextError(error, "invalid")
    }
}

export function serializePlaintextCredentialStore(store: unknown): string {
    try {
        const contents: unknown = JSON.stringify(copyPlaintextCredentialStore(store))
        if (typeof contents !== "string") {
            throw new CredentialError("invalid")
        }
        assertStoreByteSize(contents)
        return contents
    } catch (error: unknown) {
        throw sanitizePlaintextError(error, "invalid")
    }
}

function assertSupportedPath(value: unknown): asserts value is string {
    if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
        || value.includes("\0") || !path.isAbsolute(value)) {
        throw new CredentialError("invalid")
    }
    if (process.platform !== "win32") {
        return
    }
    if (!/^[A-Za-z]:\\/.test(value) || value.length > MAX_WINDOWS_PATH_LENGTH) {
        throw new CredentialError("invalid")
    }
    const components = value.slice(3) === "" ? [] : value.slice(3).split("\\")
    for (const component of components) {
        const stem = component.split(".", 1)[0].trimEnd()
        if (component.length === 0 || component.length > 255 || /[. ]$/.test(component)
            || /[\u0000-\u001f<>:"/|?*]/.test(component)
            || /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/i.test(stem)) {
            throw new CredentialError("invalid")
        }
    }
}

function isWithin(candidate: string, directory: string): boolean {
    const relative = path.relative(directory, candidate)
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function ancestorPaths(value: string): string[] {
    const ancestors: string[] = []
    let current = value
    for (;;) {
        ancestors.push(current)
        const parent = path.dirname(current)
        if (parent === current) {
            return ancestors
        }
        current = parent
    }
}

async function lstatIfExists(value: string): Promise<Stats | undefined> {
    try {
        return await lstat(value)
    } catch (error: unknown) {
        if (readErrorCode(error) === "ENOENT") {
            return undefined
        }
        throw error
    }
}

async function canonicalizeExistingPath(value: string): Promise<string> {
    const missing: string[] = []
    for (const ancestor of ancestorPaths(value)) {
        if (await lstatIfExists(ancestor) !== undefined) {
            return path.join(await realpath(ancestor), ...missing.slice().reverse())
        }
        missing.push(path.basename(ancestor))
    }
    return value
}

async function assertOutsideGit(storePath: string): Promise<void> {
    for (const ancestor of ancestorPaths(path.dirname(storePath))) {
        if (await lstatIfExists(path.join(ancestor, ".git")) !== undefined) {
            throw new CredentialError("unsafe_location")
        }
    }
}

async function assertSafeLocation(storePath: string): Promise<void> {
    const cwd = path.resolve(process.cwd())
    if (isWithin(storePath, cwd)) {
        throw new CredentialError("unsafe_location")
    }
    await assertOutsideGit(storePath)
    const candidates = new Set([storePath, await canonicalizeExistingPath(storePath)])
    const workspaces = new Set([cwd, await canonicalizeExistingPath(cwd)])
    for (const workspace of workspaces) {
        for (const candidate of candidates) {
            if (isWithin(candidate, workspace)) {
                throw new CredentialError("unsafe_location")
            }
        }
        for (const ancestor of ancestorPaths(workspace)) {
            if (await lstatIfExists(path.join(ancestor, ".git")) !== undefined) {
                const canonical = await canonicalizeExistingPath(ancestor)
                for (const candidate of candidates) {
                    if (isWithin(candidate, ancestor) || isWithin(candidate, canonical)) {
                        throw new CredentialError("unsafe_location")
                    }
                }
            }
        }
    }
    for (const candidate of candidates) {
        if (candidate !== storePath) {
            await assertOutsideGit(candidate)
        }
    }
}

export async function resolvePlaintextCredentialStorePath(options?: PlaintextCredentialOptions): Promise<string> {
    try {
        const settings = readOptions(options)
        const root: unknown = settings.globalConfigRoot ?? resolveOpenCodePaths().globalConfigRoot
        if (typeof root !== "string" || !root.isWellFormed() || root.includes("\0") || !path.isAbsolute(root)
            || (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(root))) {
            throw new CredentialError("invalid")
        }
        const normalizedRoot = path.resolve(root)
        assertSupportedPath(normalizedRoot)
        const storePath = path.join(normalizedRoot, "credentials", "profiles.json")
        assertSupportedPath(storePath)
        // Canonical paths authorize the location only; the returned path retains the fixed suffix.
        await assertSafeLocation(storePath)
        return storePath
    } catch (error: unknown) {
        throw sanitizePlaintextError(error)
    }
}

async function inspectPrivatePosixFile(storePath: string, uid: number): Promise<Stats | undefined> {
    const parent = path.dirname(storePath)
    let file: Stats | undefined
    for (const current of ancestorPaths(storePath).reverse()) {
        const metadata = await lstatIfExists(current)
        if (metadata === undefined) {
            return undefined
        }
        if (metadata.isSymbolicLink() || (current !== storePath && !metadata.isDirectory())) {
            throw new CredentialError("denied")
        }
        if (current === parent
            && (metadata.uid !== uid || (metadata.mode & PERMISSION_MASK) !== PRIVATE_DIRECTORY_MODE)) {
            throw new CredentialError("denied")
        }
        if (current === storePath) {
            if (!metadata.isFile() || metadata.uid !== uid || metadata.nlink !== 1
                || (metadata.mode & PERMISSION_MASK) !== PRIVATE_FILE_MODE) {
                throw new CredentialError("denied")
            }
            file = metadata
        }
    }
    return file
}

async function readPrivatePosixFile(storePath: string): Promise<SecureWindowsFileReadResult> {
    if (typeof process.getuid !== "function") {
        throw new CredentialError("unsupported")
    }
    const uid = process.getuid()
    const before = await inspectPrivatePosixFile(storePath, uid)
    if (before === undefined) {
        return { status: "missing" }
    }
    if (before.size > MAX_PLAINTEXT_STORE_BYTES) {
        throw new CredentialError("too_large")
    }

    const file = await open(storePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
        const opened = await file.stat()
        if (!opened.isFile() || opened.uid !== uid || opened.nlink !== 1
            || (opened.mode & PERMISSION_MASK) !== PRIVATE_FILE_MODE
            || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new CredentialError("denied")
        }
        if (opened.size > MAX_PLAINTEXT_STORE_BYTES) {
            throw new CredentialError("too_large")
        }
        const bytes = Buffer.alloc(MAX_PLAINTEXT_STORE_BYTES + 1)
        let length = 0
        while (length < bytes.length) {
            const result = await file.read(bytes, length, bytes.length - length, length)
            if (result.bytesRead === 0) {
                break
            }
            length += result.bytesRead
        }
        if (length > MAX_PLAINTEXT_STORE_BYTES) {
            throw new CredentialError("too_large")
        }
        const after = await inspectPrivatePosixFile(storePath, uid)
        if (after === undefined || after.dev !== opened.dev || after.ino !== opened.ino) {
            throw new CredentialError("denied")
        }
        try {
            return { status: "found", contents: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)) }
        } catch {
            throw new CredentialError("invalid")
        }
    } finally {
        await file.close()
    }
}

export async function readPlaintextCredentialStore(options?: PlaintextCredentialOptions): Promise<PlaintextCredentialStoreReadResult> {
    try {
        const settings = readOptions(options)
        const storePath = await resolvePlaintextCredentialStorePath(settings)
        let result: SecureWindowsFileReadResult
        if (process.platform === "win32") {
            result = await readSecureWindowsFile(storePath, MAX_PLAINTEXT_STORE_BYTES, { expectedSid: settings.expectedSid })
        } else {
            if (settings.expectedSid !== undefined) {
                throw new CredentialError("unsupported")
            }
            result = await readPrivatePosixFile(storePath)
        }
        return result.status === "missing"
            ? { status: "missing" }
            : { status: "found", store: parsePlaintextCredentialStore(result.contents) }
    } catch (error: unknown) {
        if (readErrorCode(error) === "ENOENT") {
            return { status: "missing" }
        }
        throw sanitizePlaintextError(error)
    }
}

export function createPlaintextCredentialProvider(options?: PlaintextCredentialOptions): CredentialProvider {
    return {
        async read(kind: CredentialKind, normalizedId: string): Promise<CredentialReadResult> {
            try {
                assertCredentialKind(kind)
                assertNormalizedCredentialId(kind, normalizedId)
                const result = await readPlaintextCredentialStore(options)
                if (result.status === "missing" || !Object.hasOwn(result.store.profiles, kind)) {
                    return { status: "missing" }
                }
                const profiles = result.store.profiles[kind]
                if (profiles === undefined || !Object.hasOwn(profiles, normalizedId)) {
                    return { status: "missing" }
                }
                return { status: "found", profile: profiles[normalizedId] }
            } catch (error: unknown) {
                throw sanitizePlaintextError(error, "invalid")
            }
        },
        async enumerate(kind: CredentialKind): Promise<string[]> {
            try {
                assertCredentialKind(kind)
                const result = await readPlaintextCredentialStore(options)
                if (result.status === "missing" || !Object.hasOwn(result.store.profiles, kind)) {
                    return []
                }
                return Object.keys(result.store.profiles[kind] ?? {})
            } catch (error: unknown) {
                throw sanitizePlaintextError(error, "invalid")
            }
        },
    }
}
