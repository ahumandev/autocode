import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { types } from "node:util"
import { loadAutocodeConfigDetails } from "../config"
import { normalizeCredentialId } from "../credentials/lookup"
import { createPlaintextCredentialProvider } from "../credentials/plaintext"
import { PlaintextProfilePreconditionError, writePlaintextProfile } from "../credentials/provision"
import {
    CredentialError,
    isCredentialProviderPolicy,
    type CredentialKind,
    type CredentialProfileInput,
    type CredentialProvider,
    type CredentialProviderPolicy,
} from "../credentials/types"
import { validateCredentialProfile } from "../credentials/validation"
import { createWindowsCredentialProvider, getWindowsCredentialIdentity, writeWindowsProfile } from "../credentials/windows"
import { detectDbAdapter, normalizeConnectionString } from "../utils/db-connection"

export type CredentialServiceProvider = "windows" | "linux" | "plaintext"
export type CredentialServiceErrorCode =
    | "invalid_request" | "confirmation_required" | "plaintext_confirmation_required"
    | "provider_not_allowed" | "provider_unavailable" | "duplicate_profile"
    | "profile_not_found" | "profile_shadowed" | "stale_revision" | "profile_drift" | "write_failed"

export type CredentialServiceResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: { code: CredentialServiceErrorCode; message: string } }

export interface CredentialProfileSummary {
    kind: CredentialKind
    id: string
    provider: CredentialServiceProvider
    readOnly: boolean
    unavailable: boolean
    configured: Record<string, boolean>
    revision?: string
}

export interface CredentialProviderSummary {
    provider: CredentialServiceProvider
    readOnly: boolean
    unavailable: boolean
    truncated: boolean
}

export interface CredentialProfileList {
    profiles: CredentialProfileSummary[]
    providers: CredentialProviderSummary[]
    truncated: boolean
}

export type CredentialFieldEdit = { op: "keep" } | { op: "clear" } | { op: "set"; value: string }
export interface CreateCredentialProfileInput {
    kind: CredentialKind
    id: string
    provider: CredentialServiceProvider
    fields: Record<string, string>
    confirmPlaintext?: boolean
}
export interface UpdateCredentialProfileInput {
    kind: CredentialKind
    id: string
    provider: CredentialServiceProvider
    revision: string
    confirm: true
    fields: Record<string, CredentialFieldEdit>
    confirmPlaintext?: boolean
}

export type CredentialWritePrecondition =
    | { status: "missing" }
    | { status: "found"; profile: Readonly<Record<string, string>> }

// All dependencies are server-only and must not be constructed from request data.
export interface CredentialProfileServiceOptions {
    platform?: NodeJS.Platform
    expectedSid?: string
    loadPolicy?: () => Promise<CredentialProviderPolicy>
    getWindowsIdentity?: (expectedSid?: string) => Promise<{ sid: string; account: string }>
    createProvider?: (provider: CredentialServiceProvider, expectedSid?: string) => Promise<CredentialProvider>
    // Only a trusted provider that reports every native target may assert completeness.
    windowsInventoryComplete?: boolean
    writeWindows?: (kind: CredentialKind, id: string, fields: Readonly<Record<string, string>>, expectedSid: string) => Promise<void>
    writePlaintextAtomic?: (
        kind: CredentialKind, id: string, fields: Readonly<Record<string, string>>,
        expected: CredentialWritePrecondition, expectedSid?: string,
    ) => Promise<void>
}

export interface CredentialProfileService {
    listCredentialProfiles(): Promise<CredentialServiceResult<CredentialProfileList>>
    createCredentialProfile(input: unknown): Promise<CredentialServiceResult<CredentialProfileSummary>>
    updateCredentialProfile(input: unknown): Promise<CredentialServiceResult<CredentialProfileSummary>>
}

const FIELDS: Readonly<Record<CredentialKind, readonly string[]>> = {
    rest: ["authorization", "username", "password"],
    ssh: ["host", "username", "port", "keyfile", "agent", "password", "keypass"],
    db: ["connection", "username", "password"],
}
const KINDS: readonly CredentialKind[] = ["db", "rest", "ssh"]
const PROVIDERS: readonly CredentialServiceProvider[] = ["windows", "linux", "plaintext"]
const MAX_CANDIDATES = 128
const MAX_ID_LENGTH = 256
const MESSAGES: Readonly<Record<CredentialServiceErrorCode, string>> = {
    invalid_request: "Invalid credential request.",
    confirmation_required: "Credential update confirmation is required.",
    plaintext_confirmation_required: "Plaintext credentials are stored unencrypted; confirmation is required.",
    provider_not_allowed: "Credential provider is not allowed.",
    provider_unavailable: "Credential provider is unavailable.",
    duplicate_profile: "Credential profile already exists.",
    profile_not_found: "Credential profile was not found.",
    profile_shadowed: "Credential profile is shadowed.",
    stale_revision: "Credential profile revision is stale.",
    profile_drift: "Credential profile cannot be safely updated.",
    write_failed: "Credential write failed.",
}

class ServiceFailure {
    constructor(readonly code: CredentialServiceErrorCode) {}
}

function fail(code: CredentialServiceErrorCode): never {
    throw new ServiceFailure(code)
}

function failure<T>(error: unknown, fallback: CredentialServiceErrorCode): CredentialServiceResult<T> {
    try {
        const code = !types.isProxy(error) && error instanceof ServiceFailure ? error.code : fallback
        return { ok: false, error: { code, message: MESSAGES[code] } }
    } catch {
        return { ok: false, error: { code: fallback, message: MESSAGES[fallback] } }
    }
}

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) fail("invalid_request")
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) fail("invalid_request")
    const copy: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowed.includes(key)) fail("invalid_request")
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("invalid_request")
        copy[key] = descriptor.value
    }
    return copy
}

interface Request {
    kind: CredentialKind
    id: string
    provider: CredentialServiceProvider
    fields: Record<string, string | CredentialFieldEdit>
    revision?: string
    confirmPlaintext: boolean
}

function parseRequest(input: unknown, update: boolean): Request {
    const source = object(input, update
        ? ["kind", "id", "provider", "revision", "confirm", "fields", "confirmPlaintext"]
        : ["kind", "id", "provider", "fields", "confirmPlaintext"])
    const kind = source.kind
    if (kind !== "ssh" && kind !== "rest" && kind !== "db") fail("invalid_request")
    if (typeof source.id !== "string" || source.id.length > MAX_ID_LENGTH) fail("invalid_request")
    const id = normalizeCredentialId(kind, source.id)
    const provider = source.provider
    if (provider !== "windows" && provider !== "linux" && provider !== "plaintext") fail("invalid_request")
    if (source.confirmPlaintext !== undefined && typeof source.confirmPlaintext !== "boolean") fail("invalid_request")
    if (update && (source.confirm === undefined || source.confirm === false)) fail("confirmation_required")
    if (update && source.confirm !== true) fail("invalid_request")
    if (update && (typeof source.revision !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(source.revision))) fail("invalid_request")
    const rawFields = object(source.fields, FIELDS[kind])
    const fields: Record<string, string | CredentialFieldEdit> = Object.create(null)
    for (const [key, value] of Object.entries(rawFields)) {
        if (!update) {
            if (typeof value !== "string" || !value.trim()) fail("invalid_request")
            fields[key] = value
            continue
        }
        const edit = object(value, ["op", "value"])
        if (edit.op === "keep" || edit.op === "clear") {
            if (Object.hasOwn(edit, "value")) fail("invalid_request")
            fields[key] = { op: edit.op }
        } else if (edit.op === "set" && typeof edit.value === "string" && edit.value.trim()) {
            fields[key] = { op: "set", value: edit.value }
        } else {
            fail("invalid_request")
        }
    }
    return {
        kind, id, provider, fields,
        revision: typeof source.revision === "string" ? source.revision : undefined,
        confirmPlaintext: source.confirmPlaintext === true,
    }
}

function copyProfile(kind: CredentialKind, input: unknown): Record<string, string> {
    let source: Record<string, unknown>
    try {
        source = object(input, FIELDS[kind])
    } catch {
        return fail("profile_drift")
    }
    const result: Record<string, string> = Object.create(null)
    for (const [key, value] of Object.entries(source)) {
        if (typeof value !== "string") fail("profile_drift")
        result[key] = value
    }
    return result
}

function usableProfile(kind: CredentialKind, fields: Record<string, string>): boolean {
    try {
        if (validateCredentialProfile(kind, fields).status !== "found") return false
        if (Object.values(fields).some((value: string): boolean => !value.trim())) return false
        if (kind === "rest") {
            return fields.authorization !== undefined
                ? fields.username === undefined && fields.password === undefined
                : fields.username !== undefined && fields.password !== undefined
        }
        if (kind === "ssh") {
            if (fields.port !== undefined && (!/^\d+$/.test(fields.port.trim())
                || Number(fields.port.trim()) < 1 || Number(fields.port.trim()) > 65535)) return false
            return Boolean(fields.password || fields.agent || fields.keyfile) && (!fields.keypass || Boolean(fields.keyfile))
        }
        detectDbAdapter(normalizeConnectionString(fields.connection.trim()))
        return true
    } catch {
        return false
    }
}

function providerOrder(policy: CredentialProviderPolicy, platform: NodeJS.Platform): CredentialServiceProvider[] {
    if (policy === "auto") {
        return platform === "win32" ? ["windows", "plaintext"] : platform === "linux" ? ["linux", "plaintext"] : ["plaintext"]
    }
    return [policy === "windows-credential-manager" ? "windows" : policy === "linux-secret-service" ? "linux" : "plaintext"]
}

interface Inventory {
    ids: Record<CredentialKind, Set<string>>
    unavailable: boolean
    truncated: boolean
    verified: boolean
    provider?: CredentialProvider
}

interface Snapshot {
    policy: CredentialProviderPolicy
    sid?: string
    order: CredentialServiceProvider[]
    inventories: Record<CredentialServiceProvider, Inventory>
}

function emptyInventory(): Inventory {
    return { ids: { db: new Set(), rest: new Set(), ssh: new Set() }, unavailable: true, truncated: false, verified: false }
}

export function createCredentialProfileService(options: CredentialProfileServiceOptions = {}): CredentialProfileService {
    const platform = options.platform ?? process.platform
    const key = randomBytes(32)
    let pinnedSid: string | undefined
    let mutationGate: Promise<void> = Promise.resolve()

    async function loadPolicy(): Promise<CredentialProviderPolicy> {
        if (options.loadPolicy !== undefined) {
            const policy = await options.loadPolicy()
            if (!isCredentialProviderPolicy(policy)) fail("provider_unavailable")
            return policy
        }
        const details = await loadAutocodeConfigDetails({ worktree: process.cwd(), directory: process.cwd() })
        if (details.failure !== undefined || details.config === undefined
            || details.candidates.some((candidate): boolean => candidate.roles.includes("global") && candidate.state === "unreadable")) {
            fail("provider_unavailable")
        }
        return details.config.credentials.provider
    }

    async function identity(): Promise<string | undefined> {
        if (platform !== "win32") {
            if (options.expectedSid !== undefined) fail("provider_unavailable")
            return undefined
        }
        const getIdentity = options.getWindowsIdentity ?? ((expectedSid?: string): Promise<{ sid: string; account: string }> =>
            getWindowsCredentialIdentity({ expectedSid }))
        const observed = await getIdentity(pinnedSid ?? options.expectedSid)
        if (typeof observed.sid !== "string" || !/^S-\d+(?:-\d+)+$/i.test(observed.sid)
            || (options.expectedSid !== undefined && observed.sid !== options.expectedSid)
            || (pinnedSid !== undefined && observed.sid !== pinnedSid)) fail("provider_unavailable")
        pinnedSid = observed.sid
        return pinnedSid
    }

    async function createProvider(provider: CredentialServiceProvider, sid?: string): Promise<CredentialProvider> {
        if (options.createProvider !== undefined) return options.createProvider(provider, sid)
        if (provider === "plaintext") return createPlaintextCredentialProvider({ expectedSid: sid })
        if (provider === "windows" && platform === "win32") return createWindowsCredentialProvider({ expectedSid: sid })
        if (provider === "linux" && platform === "linux") {
            const module = await import("../credentials/linux.js")
            return module.createLinuxSecretServiceProvider({ strictInventory: true })
        }
        return fail("provider_unavailable")
    }

    function writable(provider: CredentialServiceProvider): boolean {
        if (provider === "linux") return false
        if (provider === "plaintext") return options.createProvider === undefined || options.writePlaintextAtomic !== undefined
        return platform === "win32"
    }

    async function snapshot(): Promise<Snapshot> {
        const policy = await loadPolicy()
        const sid = await identity()
        const order = providerOrder(policy, platform)
        const inventories: Record<CredentialServiceProvider, Inventory> = {
            windows: emptyInventory(), linux: emptyInventory(), plaintext: emptyInventory(),
        }
        for (const name of order) {
            const inventory = inventories[name]
            if ((name === "windows" && platform !== "win32") || (name === "linux" && platform !== "linux")) continue
            try {
                const provider = await createProvider(name, sid)
                if (provider.enumerate === undefined) continue
                inventory.provider = provider
                inventory.unavailable = false
                // The native Windows enumerator silently omits noncanonical targets.
                inventory.verified = name !== "windows"
                    || (options.createProvider !== undefined && options.windowsInventoryComplete === true)
                for (const kind of KINDS) {
                    const ids = await provider.enumerate(kind)
                    if (!Array.isArray(ids)) throw new Error()
                    if (ids.length > MAX_CANDIDATES) {
                        inventory.truncated = true
                        inventory.unavailable = true
                    }
                    for (const raw of ids.slice(0, MAX_CANDIDATES)) {
                        if (typeof raw !== "string" || raw.length > MAX_ID_LENGTH
                            || normalizeCredentialId(kind, raw) !== raw || inventory.ids[kind].has(raw)) throw new Error()
                        inventory.ids[kind].add(raw)
                    }
                }
            } catch (error: unknown) {
                if (!types.isProxy(error) && error instanceof CredentialError
                    && Object.getOwnPropertyDescriptor(error, "code")?.value === "too_large") inventory.truncated = true
                inventory.unavailable = true
                for (const kind of KINDS) inventory.ids[kind].clear()
            }
        }
        return { policy, sid, order, inventories }
    }

    async function read(snapshotValue: Snapshot, provider: CredentialServiceProvider, kind: CredentialKind, id: string): Promise<Record<string, string> | undefined> {
        const inventory = snapshotValue.inventories[provider]
        if (inventory.unavailable || inventory.provider === undefined) fail("provider_unavailable")
        let result: Awaited<ReturnType<CredentialProvider["read"]>>
        try {
            result = await inventory.provider.read(kind, id)
        } catch {
            return fail("provider_unavailable")
        }
        if (result.status === "missing") {
            if (inventory.ids[kind].has(id)) fail("profile_drift")
            return undefined
        }
        if (result.status === "unavailable") fail("provider_unavailable")
        if (result.status !== "found" || !inventory.ids[kind].has(id)) fail("profile_drift")
        return copyProfile(kind, result.profile)
    }

    function revision(snapshotValue: Snapshot, provider: CredentialServiceProvider, kind: CredentialKind, id: string, fields: Record<string, string>): string {
        const entries = Object.keys(fields).sort().map((field: string): [string, string] => [field, fields[field]])
        return createHmac("sha256", key).update(JSON.stringify([kind, id, provider, snapshotValue.policy, snapshotValue.order, snapshotValue.sid ?? null, entries])).digest("base64url")
    }

    function sameRevision(left: string, right: string): boolean {
        const first = Buffer.from(left, "utf8")
        const second = Buffer.from(right, "utf8")
        return first.length === second.length && timingSafeEqual(first, second)
    }

    function summary(snapshotValue: Snapshot, provider: CredentialServiceProvider, kind: CredentialKind, id: string, fields: Record<string, string>, unavailable: boolean): CredentialProfileSummary {
        const configured: Record<string, boolean> = Object.create(null)
        for (const field of FIELDS[kind]) configured[field] = typeof fields[field] === "string" && fields[field].trim().length > 0
        const readOnly = !writable(provider)
        const result: CredentialProfileSummary = { kind, id, provider, readOnly, unavailable, configured }
        if (!readOnly && !unavailable && usableProfile(kind, fields)) result.revision = revision(snapshotValue, provider, kind, id, fields)
        return result
    }

    async function target(snapshotValue: Snapshot, request: Request, update: boolean): Promise<Record<string, string> | undefined> {
        if (!snapshotValue.order.includes(request.provider)) fail("provider_not_allowed")
        let selected: CredentialServiceProvider | undefined
        let targetFields: Record<string, string> | undefined
        for (const provider of snapshotValue.order) {
            if (!snapshotValue.inventories[provider].verified) fail("provider_unavailable")
            const fields = await read(snapshotValue, provider, request.kind, request.id)
            if (fields !== undefined) {
                selected ??= provider
                if (provider === request.provider) targetFields = fields
                if (!update) fail("duplicate_profile")
            }
        }
        if (update && targetFields === undefined) fail("profile_not_found")
        if (update && selected !== request.provider) fail("profile_shadowed")
        if (targetFields !== undefined && !usableProfile(request.kind, targetFields)) fail("profile_drift")
        return targetFields
    }

    async function list(): Promise<CredentialProfileList> {
        const current = await snapshot()
        const profiles: CredentialProfileSummary[] = []
        let count = 0
        let truncated = current.order.some((name): boolean => current.inventories[name].truncated)
        for (const kind of KINDS) {
            const ids = new Set<string>()
            for (const provider of current.order) for (const id of current.inventories[provider].ids[kind]) ids.add(id)
            for (const id of [...ids].sort()) {
                if (count++ >= MAX_CANDIDATES) {
                    truncated = true
                    break
                }
                let blocked = false
                for (const provider of current.order) {
                    if (current.inventories[provider].unavailable) {
                        blocked = true
                        continue
                    }
                    try {
                        const fields = await read(current, provider, kind, id)
                        if (fields !== undefined) {
                            profiles.push(summary(current, provider, kind, id, fields, blocked || !current.inventories[provider].verified))
                            break
                        }
                        blocked ||= !current.inventories[provider].verified
                    } catch {
                        blocked = true
                        current.inventories[provider].unavailable = true
                    }
                }
            }
        }
        const providers = PROVIDERS.map((provider): CredentialProviderSummary => ({
            provider, readOnly: !writable(provider), unavailable: current.inventories[provider].unavailable || !current.inventories[provider].verified,
            truncated: current.inventories[provider].truncated,
        }))
        return { profiles, providers, truncated }
    }

    async function mutate(input: unknown, update: boolean): Promise<CredentialProfileSummary> {
        let request: Request
        try {
            request = parseRequest(input, update)
        } catch (error: unknown) {
            if (error instanceof ServiceFailure) throw error
            return fail("invalid_request")
        }
        if (request.provider === "plaintext" && !request.confirmPlaintext) fail("plaintext_confirmation_required")
        if (request.provider === "linux") fail("provider_not_allowed")
        const current = await snapshot()
        if (!current.order.includes(request.provider)) fail("provider_not_allowed")
        if (!writable(request.provider)) fail("provider_unavailable")
        const previous = await target(current, request, update)
        if (update && previous !== undefined && !sameRevision(request.revision ?? "", revision(current, request.provider, request.kind, request.id, previous))) {
            fail("stale_revision")
        }
        const fields: Record<string, string> = Object.assign(Object.create(null), previous ?? {})
        let changed = !update
        for (const [field, value] of Object.entries(request.fields)) {
            if (typeof value === "string") {
                fields[field] = value
            } else if (value.op === "clear" && Object.hasOwn(fields, field)) {
                delete fields[field]
                changed = true
            } else if (value.op === "set" && fields[field] !== value.value) {
                fields[field] = value.value
                changed = true
            }
        }
        if (!changed || !usableProfile(request.kind, fields)) fail("invalid_request")
        const rechecked = await snapshot()
        if (rechecked.policy !== current.policy || rechecked.sid !== current.sid) fail("stale_revision")
        const latest = await target(rechecked, request, update)
        if (update && (latest === undefined || previous === undefined
            || !sameRevision(revision(current, request.provider, request.kind, request.id, previous),
                revision(rechecked, request.provider, request.kind, request.id, latest)))) fail("stale_revision")
        try {
            if (request.provider === "windows") {
                if (rechecked.sid === undefined) fail("provider_unavailable")
                if (options.writeWindows !== undefined) {
                    await options.writeWindows(request.kind, request.id, fields, rechecked.sid)
                } else {
                    await writeWindowsProfile(request.kind, request.id, fields as CredentialProfileInput<CredentialKind>, { expectedSid: rechecked.sid })
                }
            } else {
                const expected: CredentialWritePrecondition = latest === undefined ? { status: "missing" } : { status: "found", profile: latest }
                if (options.writePlaintextAtomic !== undefined) {
                    await options.writePlaintextAtomic(request.kind, request.id, fields, expected, rechecked.sid)
                } else {
                    await writePlaintextProfile(request.kind, request.id, fields, { expectedSid: rechecked.sid },
                        { kind: request.kind, id: request.id, ...expected })
                }
            }
        } catch (error: unknown) {
            if (error instanceof ServiceFailure) throw error
            if (error instanceof PlaintextProfilePreconditionError) {
                return fail(error.reason === "drift" ? "profile_drift" : update ? "stale_revision" : "duplicate_profile")
            }
            return fail("write_failed")
        }
        const verified = await snapshot()
        if (verified.policy !== rechecked.policy || verified.sid !== rechecked.sid) fail("profile_drift")
        const saved = await target(verified, request, true)
        if (saved === undefined || !sameRevision(revision(verified, request.provider, request.kind, request.id, fields),
            revision(verified, request.provider, request.kind, request.id, saved))) fail("profile_drift")
        return summary(verified, request.provider, request.kind, request.id, saved, false)
    }

    function enqueue(input: unknown, update: boolean): Promise<CredentialServiceResult<CredentialProfileSummary>> {
        const operation = mutationGate.then(async (): Promise<CredentialServiceResult<CredentialProfileSummary>> => {
            try {
                return { ok: true, data: await mutate(input, update) }
            } catch (error: unknown) {
                return failure(error, "provider_unavailable")
            }
        })
        mutationGate = operation.then((): void => {}, (): void => {})
        return operation
    }

    return {
        async listCredentialProfiles(): Promise<CredentialServiceResult<CredentialProfileList>> {
            try {
                return { ok: true, data: await list() }
            } catch (error: unknown) {
                return failure(error, "provider_unavailable")
            }
        },
        createCredentialProfile(input: unknown): Promise<CredentialServiceResult<CredentialProfileSummary>> {
            return enqueue(input, false)
        },
        updateCredentialProfile(input: unknown): Promise<CredentialServiceResult<CredentialProfileSummary>> {
            return enqueue(input, true)
        },
    }
}
