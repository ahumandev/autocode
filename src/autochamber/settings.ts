import { Buffer } from "node:buffer"
import { createHmac, randomBytes } from "node:crypto"
import { closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path"
import { types } from "node:util"
import { getNodeValue, parseTree, type Node, type ParseError } from "jsonc-parser/lib/esm/main.js"
import {
    enumerateAutocodeConfigCandidates,
    loadAutocodeConfigDetails,
    validateGlobalCredentialDocument,
    type AutocodeConfigCandidate,
    type AutocodeConfigCandidateDetail,
    type AutocodeConfigContext,
    type AutocodeConfigDetails,
    type AutocodeConfigOrigin,
    type AutocodeConfigRole,
    type AutocodeConfigTraceEvent,
    type PermissionAction,
} from "../config"
import { isCredentialProviderPolicy } from "../credentials/types"
import { createJsoncDocumentEditor, findUniqueJsoncNode, removeJsoncNodePreservingComments } from "../tools/config/json"

export type SettingsContext = AutocodeConfigContext
export type SettingsScalar = string | number | boolean
export type SettingsErrorCode = "invalid_request" | "invalid_config" | "conflict" | "io_error"

export type SettingsPatch =
    | { op: "set"; path: string[]; value: SettingsScalar }
    | { op: "remove"; path: string[] }
    | { op: "insert-rule"; index?: number; resource: string; effect: PermissionAction }
    | { op: "update-rule"; index: number; resource?: string; effect?: PermissionAction }
    | { op: "remove-rule"; index: number }

export type SettingsUpdateInput = {
    scopeId: string
    revision: string
    patches: SettingsPatch[]
}

export type SettingsOrigin = {
    file: string
    path: (string | number)[]
    scopeId: string | null
}

export type SettingsValue = {
    path: string[]
    value: SettingsScalar
    legacy?: "used" | "overridden" | "ignored" | "unresolved"
}

export type SettingsExternalDirectoryRule = {
    index: number
    resource: string
    effect: PermissionAction
}

export type SettingsScope = {
    id: string
    file: string
    scopeRoot: string
    roles: AutocodeConfigRole[]
    state: "missing" | "valid" | "invalid" | "unreadable"
    revision: string | null
    values: SettingsValue[]
    externalDirectory: SettingsExternalDirectoryRule[]
    permissionCount: number
}

export type SettingsEffectiveValue = {
    path: string[]
    value: SettingsScalar | null
    source: SettingsOrigin | null
    overridden: SettingsOrigin[]
    cause?: SettingsOrigin
}

export type SettingsEffectiveExternalDirectoryRule = {
    resource: string
    effect: PermissionAction
    source: SettingsOrigin | null
    overridden: SettingsOrigin[]
}

export type SettingsSnapshot = {
    scopes: SettingsScope[]
    effective: {
        values: SettingsEffectiveValue[]
        externalDirectory: SettingsEffectiveExternalDirectoryRule[]
    } | null
    issue?: { code: "invalid_config" | "unreadable"; file: string }
}

const SETTINGS_ERROR_MESSAGES: Readonly<Record<SettingsErrorCode, string>> = {
    invalid_request: "Invalid settings request.",
    invalid_config: "Invalid settings configuration.",
    conflict: "Settings revision is stale.",
    io_error: "Settings storage is unavailable.",
}

export class SettingsError extends Error {
    readonly code: SettingsErrorCode

    constructor(code: SettingsErrorCode) {
        super(SETTINGS_ERROR_MESSAGES[code])
        this.name = "SettingsError"
        this.code = code
    }
}

const TIERS = ["cheap", "fast", "operator", "context", "balanced", "smart", "spy"] as const
const FIELDS = ["model", "variant"] as const
const SECRET = randomBytes(32)
const DANGEROUS_SEGMENTS = new Set(["__proto__", "prototype", "constructor"])

function normalizedFile(file: string): string {
    const path = resolve(file)
    return process.platform === "win32" ? path.toLowerCase() : path
}

export function settingsScopeId(file: string): string {
    return createHmac("sha256", SECRET).update("scope\0").update(normalizedFile(file)).digest("base64url")
}

export function settingsRevision(file: string, bytes: Uint8Array | null): string {
    const hash = createHmac("sha256", SECRET).update("revision\0")
        .update(JSON.stringify(normalizedFile(file))).update("\0")
    if (bytes === null) hash.update("missing")
    else hash.update("present\0").update(bytes)
    return hash.digest("base64url")
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function property(value: unknown, key: string): unknown {
    return record(value) && Object.hasOwn(value, key) ? value[key] : undefined
}

function safeProvider(value: string): boolean {
    return !DANGEROUS_SEGMENTS.has(value) && !TIERS.some((tier): boolean => tier === value)
}

function scalar(value: unknown): value is SettingsScalar {
    return typeof value === "string" || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))
}

function effect(value: unknown): value is PermissionAction {
    return value === "ask" || value === "allow" || value === "deny"
}

function externalRule(value: unknown): value is { action: "external_directory"; resource: string; effect: PermissionAction } {
    return record(value) && value.action === "external_directory"
        && typeof value.resource === "string" && effect(value.effect)
}

function samePath(left: readonly (string | number)[], right: readonly (string | number)[]): boolean {
    return left.length === right.length && left.every((part, index): boolean => part === right[index])
}

function legacyStatus(file: string, path: string[], trace: AutocodeConfigTraceEvent[], resolved: boolean): NonNullable<SettingsValue["legacy"]> {
    let matching = -1
    for (let index = 0; index < trace.length; index++) {
        const origin = trace[index].origin
        if (origin && normalizedFile(origin.file) === normalizedFile(file) && samePath(origin.path, path)) matching = index
    }
    if (matching < 0) return "unresolved"
    const event = trace[matching]
    if (event.action === "ignored") return "ignored"
    if (!resolved) return "unresolved"
    const superseded = trace.slice(matching + 1).some((later): boolean =>
        samePath(later.target, event.target) && (later.action === "set" || later.action === "replace" || later.action === "clear"))
    return superseded ? "overridden" : "used"
}

function rawValues(candidate: AutocodeConfigCandidateDetail, trace: AutocodeConfigTraceEvent[], resolved: boolean): SettingsValue[] {
    if (candidate.state === "missing" || candidate.state === "unreadable") return []
    const root = "document" in candidate ? candidate.document : undefined
    const ac = property(root, "autocode")
    const values: SettingsValue[] = []
    const add = (path: string[], value: unknown): void => {
        if (scalar(value)) values.push({ path, value })
    }
    const selector = property(ac, "tier")
    if (typeof selector === "string") add(["autocode", "tier"], selector)
    const tiers = property(ac, "tiers")
    if (record(tiers)) {
        for (const [name, entry] of Object.entries(tiers)) {
            if (TIERS.some((tier): boolean => tier === name)) {
                for (const field of FIELDS) {
                    const value = property(entry, field)
                    if (typeof value === "string") add(["autocode", "tiers", name, field], value)
                }
            } else if (safeProvider(name)) {
                for (const tier of TIERS) for (const field of FIELDS) {
                    const value = property(property(entry, tier), field)
                    if (typeof value === "string") add(["autocode", "tiers", name, tier, field], value)
                }
            }
        }
    }
    for (const field of FIELDS) for (const tier of TIERS) {
        const value = property(property(ac, field), tier)
        if (typeof value !== "string") continue
        const path = ["autocode", field, tier]
        values.push({ path, value, legacy: legacyStatus(candidate.path, path, trace, resolved) })
    }
    const sandbox = property(ac, "sandbox")
    const sync = property(sandbox, "sync_method")
    if (sync === "auto" || sync === "overlayfs" || sync === "reflink" || sync === "copy") {
        add(["autocode", "sandbox", "sync_method"], sync)
    }
    const distro = property(sandbox, "distro")
    const cache = property(distro, "cache_path")
    if (typeof cache === "string") add(["autocode", "sandbox", "distro", "cache_path"], cache)
    const expire = property(distro, "expire")
    if (typeof expire === "string" || (typeof expire === "number" && Number.isFinite(expire))) {
        add(["autocode", "sandbox", "distro", "expire"], expire)
    }
    const freeze = property(property(ac, "skills"), "freeze")
    if (typeof freeze === "boolean") add(["autocode", "skills", "freeze"], freeze)
    const directory = property(property(ac, "memory"), "directory")
    if (typeof directory === "string" && directory.trim()) add(["autocode", "memory", "directory"], directory)
    if (candidate.roles.includes("global")) {
        try {
            validateGlobalCredentialDocument(root)
            const provider = property(property(root, "credentials"), "provider")
            if (isCredentialProviderPolicy(provider)) add(["credentials", "provider"], provider)
        } catch {
            // Invalid credential documents must not expose their contents.
        }
    }
    return values
}

function scopeProjection(candidate: AutocodeConfigCandidateDetail, trace: AutocodeConfigTraceEvent[], resolved: boolean): SettingsScope {
    const document = candidate.state === "valid" || candidate.state === "invalid" ? candidate.document : undefined
    const permissions = property(document, "permissions")
    const externalDirectory: SettingsExternalDirectoryRule[] = []
    if (Array.isArray(permissions)) permissions.forEach((rule: unknown, index: number): void => {
        if (externalRule(rule)) externalDirectory.push({ index, resource: rule.resource, effect: rule.effect })
    })
    return {
        id: settingsScopeId(candidate.path),
        file: candidate.path,
        scopeRoot: candidate.scopeRoot,
        roles: [...candidate.roles],
        state: candidate.state,
        revision: candidate.state === "unreadable" ? null
            : settingsRevision(candidate.path, "bytes" in candidate ? candidate.bytes : null),
        values: rawValues(candidate, trace, resolved),
        externalDirectory,
        permissionCount: Array.isArray(permissions) ? permissions.length : 0,
    }
}

function origin(value: AutocodeConfigOrigin, scopes: SettingsScope[]): SettingsOrigin {
    const scope = scopes.find((candidate): boolean => normalizedFile(candidate.file) === normalizedFile(value.file))
    return { file: value.file, path: [...value.path], scopeId: scope?.id ?? null }
}

function canonicalTarget(target: (string | number)[]): string[] | undefined {
    if (target.length === 1 && target[0] === "selectedProvider") return ["autocode", "tier"]
    if (target.length === 3 && target[0] === "tiers"
        && TIERS.some((tier): boolean => tier === target[1]) && FIELDS.some((field): boolean => field === target[2])) {
        return ["autocode", "tiers", target[1] as string, target[2] as string]
    }
    if (target.length === 4 && target[0] === "providers" && typeof target[1] === "string" && safeProvider(target[1])
        && TIERS.some((tier): boolean => tier === target[2]) && FIELDS.some((field): boolean => field === target[3])) {
        return ["autocode", "tiers", target[1], target[2] as string, target[3] as string]
    }
    if (samePath(target, ["sandbox", "sync_method"])) return ["autocode", "sandbox", "sync_method"]
    if (samePath(target, ["sandbox", "distro_cache_path"])) return ["autocode", "sandbox", "distro", "cache_path"]
    if (samePath(target, ["sandbox", "distro_expire"])) return ["autocode", "sandbox", "distro", "expire"]
    if (samePath(target, ["skills", "freeze"])) return ["autocode", "skills", "freeze"]
    if (samePath(target, ["memory", "directory"])) return ["autocode", "memory", "directory"]
    if (samePath(target, ["credentials", "provider"])) return ["credentials", "provider"]
    return undefined
}

function effectiveValues(details: AutocodeConfigDetails, scopes: SettingsScope[]): SettingsEffectiveValue[] {
    const config = details.config
    if (!config) return []
    const values = new Map<string, SettingsEffectiveValue>()
    const applied = new Set<string>()
    const cleared = new Set<string>()
    for (const event of details.trace) {
        const path = canonicalTarget(event.target)
        if (!path || event.action === "ignored" || event.action === "append") continue
        const key = JSON.stringify(path)
        const current: SettingsEffectiveValue = values.get(key) ?? { path, value: null, source: null, overridden: [] }
        if (current.source) current.overridden.push(current.source)
        current.source = event.origin ? origin(event.origin, scopes) : null
        if (event.cause) current.cause = origin(event.cause, scopes)
        else delete current.cause
        if (event.action === "set" || event.action === "replace") applied.add(key)
        if (event.action === "clear") cleared.add(key)
        else cleared.delete(key)
        values.set(key, current)
    }
    const set = (path: string[], value: unknown): void => {
        if (!scalar(value)) return
        const key = JSON.stringify(path)
        const current: SettingsEffectiveValue = values.get(key) ?? { path, value: null, source: null, overridden: [] }
        current.value = value
        values.set(key, current)
    }
    set(["autocode", "tier"], details.tierResolution?.selectedProvider)
    for (const tier of TIERS) for (const field of FIELDS) {
        const value = config.tiers[tier]?.[field]
        if (typeof value === "string") set(["autocode", "tiers", tier, field], value)
    }
    for (const [provider, tiers] of Object.entries(details.tierResolution?.providerTiers ?? {})) {
        if (!safeProvider(provider)) continue
        for (const tier of TIERS) for (const field of FIELDS) {
            const value = tiers[tier]?.[field]
            if (typeof value === "string") set(["autocode", "tiers", provider, tier, field], value)
        }
    }
    set(["autocode", "sandbox", "sync_method"], config.sandbox.sync_method)
    set(["autocode", "sandbox", "distro", "cache_path"], config.sandbox.distro_cache_path)
    set(["autocode", "sandbox", "distro", "expire"], config.sandbox.distro_expire)
    set(["autocode", "skills", "freeze"], config.skills?.freeze)
    set(["autocode", "memory", "directory"], config.memory.directory)
    set(["credentials", "provider"], config.credentials.provider)
    return [...values.entries()]
        .filter(([key, value]): boolean => value.value !== null || (applied.has(key) && cleared.has(key)))
        .map(([, value]): SettingsEffectiveValue => value)
}

function effectivePermissions(details: AutocodeConfigDetails, scopes: SettingsScope[]): SettingsEffectiveExternalDirectoryRule[] {
    const events = details.trace.filter((event): boolean =>
        samePath(event.target, ["externalDirectoryPermissions"]) && event.action === "append" && event.permission !== undefined)
    const previous = new Map<string, SettingsOrigin[]>()
    return (details.config?.externalDirectoryPermissions ?? []).map((rule, index): SettingsEffectiveExternalDirectoryRule => {
        const event = events[index]
        const source = event?.origin ? origin(event.origin, scopes) : null
        const overridden = [...(previous.get(rule.resource) ?? [])]
        if (source) previous.set(rule.resource, [...overridden, source])
        return { resource: rule.resource, effect: rule.effect, source, overridden }
    })
}

export async function readSettings(context: SettingsContext): Promise<SettingsSnapshot> {
    validateContext(context)
    try {
        const details = await loadAutocodeConfigDetails(context)
        const scopes: SettingsScope[] = []
        const byFile = new Map<string, SettingsScope>()
        for (const candidate of details.candidates) {
            const key = normalizedFile(candidate.path)
            const existing = byFile.get(key)
            if (existing) {
                for (const role of candidate.roles) if (!existing.roles.includes(role)) existing.roles.push(role)
            } else {
                const scope = scopeProjection(candidate, details.trace, details.failure === undefined)
                scopes.push(scope)
                byFile.set(key, scope)
            }
        }
        const unreadable = scopes.find((scope): boolean => scope.state === "unreadable")
        const issue = details.failure
            ? { code: details.failure.kind === "invalid" ? "invalid_config" as const : "unreadable" as const, file: details.failure.file }
            : unreadable ? { code: "unreadable" as const, file: unreadable.file } : undefined
        return {
            scopes,
            effective: details.config ? {
                values: effectiveValues(details, scopes),
                externalDirectory: effectivePermissions(details, scopes),
            } : null,
            ...(issue ? { issue } : {}),
        }
    } catch {
        throw new SettingsError("io_error")
    }
}

const MAX_PATCHES = 100
const MAX_STRING = 8192
const MAX_SEGMENT = 256
const MAX_INDEX = 100000
let settingsLock: Promise<void> = Promise.resolve()

function invalidRequest(): never {
    throw new SettingsError("invalid_request")
}

function validateContext(context: SettingsContext): void {
    const source = inputObject(context, ["worktree", "directory"])
    const worktree = source.worktree
    const directory = source.directory
    if ((worktree === null || worktree === undefined) && (directory === null || directory === undefined)) return
    if (typeof worktree !== "string" || typeof directory !== "string") invalidRequest()
}

function inputObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!record(value) || types.isProxy(value)) return invalidRequest()
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return invalidRequest()
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !keys.includes(key)) return invalidRequest()
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return invalidRequest()
        result[key] = descriptor.value
    }
    return result
}

function inputArray(value: unknown, maximum: number): unknown[] {
    if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
        || value.length > maximum) return invalidRequest()
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1) return invalidRequest()
    const result: unknown[] = []
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) return invalidRequest()
        result.push(descriptor.value)
    }
    return result
}

function boundedString(value: unknown, maximum: number = MAX_STRING): value is string {
    return typeof value === "string" && value.length <= maximum
}

function indexValue(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_INDEX
}

function tier(value: string): boolean {
    return TIERS.some((item): boolean => item === value)
}

function field(value: string): boolean {
    return FIELDS.some((item): boolean => item === value)
}

function allowedLeaf(path: string[], global: boolean): boolean {
    if (path.some((segment): boolean => segment.length > MAX_SEGMENT || segment.includes("\0") || DANGEROUS_SEGMENTS.has(segment))) return false
    if (global && samePath(path, ["credentials", "provider"])) return true
    if (samePath(path, ["autocode", "tier"]) || samePath(path, ["autocode", "sandbox", "sync_method"])
        || samePath(path, ["autocode", "sandbox", "distro", "cache_path"])
        || samePath(path, ["autocode", "sandbox", "distro", "expire"])
        || samePath(path, ["autocode", "skills", "freeze"]) || samePath(path, ["autocode", "memory", "directory"])) return true
    if (path[0] !== "autocode") return false
    if (path.length === 3 && field(path[1]) && tier(path[2])) return true
    if (path[1] !== "tiers") return false
    if (path.length === 4) return tier(path[2]) && field(path[3])
    return path.length === 5 && safeProvider(path[2]) && tier(path[3]) && field(path[4])
}

function allowedValue(path: string[], value: unknown): value is SettingsScalar {
    if (typeof value === "string" && value.length > MAX_STRING) return false
    if (samePath(path, ["credentials", "provider"])) return isCredentialProviderPolicy(value)
    if (samePath(path, ["autocode", "sandbox", "sync_method"])) {
        return value === "auto" || value === "overlayfs" || value === "reflink" || value === "copy"
    }
    if (samePath(path, ["autocode", "sandbox", "distro", "expire"])) {
        return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    }
    if (samePath(path, ["autocode", "skills", "freeze"])) return typeof value === "boolean"
    if (samePath(path, ["autocode", "memory", "directory"])) return typeof value === "string" && value.trim().length > 0
    return typeof value === "string"
}

function parsePatch(value: unknown): SettingsPatch {
    const source = inputObject(value, ["op", "path", "value", "index", "resource", "effect"])
    if (source.op === "set" || source.op === "remove") {
        const expected = source.op === "set" ? ["op", "path", "value"] : ["op", "path"]
        if (Object.keys(source).some((key): boolean => !expected.includes(key))) return invalidRequest()
        const parts = inputArray(source.path, 5)
        if (!parts.every((part): boolean => boundedString(part, MAX_SEGMENT))) return invalidRequest()
        const path = parts as string[]
        if (source.op === "remove") return { op: "remove", path }
        if (!scalar(source.value) || !boundedScalar(source.value)) return invalidRequest()
        return { op: "set", path, value: source.value }
    }
    if (source.op === "insert-rule") {
        if (Object.keys(source).some((key): boolean => !["op", "index", "resource", "effect"].includes(key))
            || !boundedString(source.resource) || !effect(source.effect)
            || (Object.hasOwn(source, "index") && !indexValue(source.index))) return invalidRequest()
        return { op: "insert-rule", resource: source.resource, effect: source.effect,
            ...(indexValue(source.index) ? { index: source.index } : {}) }
    }
    if (source.op === "update-rule") {
        if (Object.keys(source).some((key): boolean => !["op", "index", "resource", "effect"].includes(key))
            || !indexValue(source.index) || (!Object.hasOwn(source, "resource") && !Object.hasOwn(source, "effect"))
            || (Object.hasOwn(source, "resource") && !boundedString(source.resource))
            || (Object.hasOwn(source, "effect") && !effect(source.effect))) return invalidRequest()
        return { op: "update-rule", index: source.index,
            ...(typeof source.resource === "string" ? { resource: source.resource } : {}),
            ...(effect(source.effect) ? { effect: source.effect } : {}) }
    }
    if (source.op === "remove-rule" && Object.keys(source).every((key): boolean => key === "op" || key === "index")
        && indexValue(source.index)) return { op: "remove-rule", index: source.index }
    return invalidRequest()
}

function boundedScalar(value: SettingsScalar): boolean {
    return typeof value !== "string" || value.length <= MAX_STRING
}

function parseUpdate(input: unknown): SettingsUpdateInput {
    const source = inputObject(input, ["scopeId", "revision", "patches"])
    if (typeof source.scopeId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(source.scopeId)
        || typeof source.revision !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(source.revision)) return invalidRequest()
    return { scopeId: source.scopeId, revision: source.revision, patches: inputArray(source.patches, MAX_PATCHES).map(parsePatch) }
}

function tree(raw: string): Node {
    const errors: ParseError[] = []
    const root = parseTree(raw, errors, { allowTrailingComma: true, disallowComments: false })
    if (!root || root.type !== "object" || errors.length > 0) throw new SettingsError("invalid_config")
    return root
}

function checkedNode(root: Node, path: readonly (string | number)[]): Node | undefined {
    let current: Node = root
    for (const part of path) {
        if ((typeof part === "string" && current.type !== "object") || (typeof part === "number" && current.type !== "array")) {
            throw new SettingsError("invalid_config")
        }
        let next: Node | undefined
        try {
            next = findUniqueJsoncNode(current, [part])
        } catch {
            throw new SettingsError("invalid_config")
        }
        if (!next) return undefined
        current = next
    }
    return current
}

function checkProviderPath(raw: string, path: string[]): void {
    if (path.length !== 5 || path[0] !== "autocode" || path[1] !== "tiers") return
    const provider = path[2]
    if (/,(?=\s*[}\]])/.test(JSON.stringify(provider))) invalidRequest()
    const tiers = checkedNode(tree(raw), ["autocode", "tiers"])
    if (!tiers || tiers.type !== "object") return
    for (const member of tiers.children ?? []) {
        const key = member.children?.[0]
        if (!key || key.type !== "string") throw new SettingsError("invalid_config")
        const token = raw.slice(key.offset, key.offset + key.length)
        if (!/,(?=\s*[}\]])/.test(token)) continue
        // The loader applies trailing-comma removal to quoted keys as well.
        const loaderKey: unknown = JSON.parse(token.replace(/,(\s*[}\]])/g, "$1"))
        if (key.value === provider || loaderKey === provider) throw new SettingsError("invalid_config")
    }
}

function createNode(raw: string, path: (string | number)[], value: unknown, index: number | null = null): string {
    const editor = createJsoncDocumentEditor(raw)
    editor.apply({ kind: "create", path, value, index })
    return editor.toString()
}

function encodedScalar(value: SettingsScalar): string {
    // The shared loader strips comma-before-bracket sequences even inside strings.
    return JSON.stringify(value).replace(/,(?=\s*[}\]])/g, "\\u002c")
}

function setNode(raw: string, path: (string | number)[], value: SettingsScalar): string {
    const node = checkedNode(tree(raw), path)
    if (!node) {
        const created = createNode(raw, path, value)
        if (!checkedNode(tree(created), path)) throw new SettingsError("invalid_config")
        return setNode(created, path, value)
    }
    if (node.type === "object" || node.type === "array") throw new SettingsError("invalid_config")
    const token = raw.slice(node.offset, node.offset + node.length)
    if (Object.is(getNodeValue(node), value) && !/,(?=\s*[}\]])/.test(token)) return raw
    return raw.slice(0, node.offset) + encodedScalar(value) + raw.slice(node.offset + node.length)
}

function removeNode(raw: string, path: (string | number)[]): string {
    const node = checkedNode(tree(raw), path)
    if (!node) return raw
    if (node.type === "object" || node.type === "array") throw new SettingsError("invalid_config")
    return removeJsoncNodePreservingComments(raw, path)
}

function editRule(raw: string, patch: Extract<SettingsPatch, { op: "insert-rule" | "update-rule" | "remove-rule" }>): string {
    let root = tree(raw)
    let permissions = checkedNode(root, ["permissions"])
    if (!permissions && patch.op === "insert-rule") {
        raw = createNode(raw, ["permissions"], [])
        root = tree(raw)
        permissions = checkedNode(root, ["permissions"])
    }
    if (!permissions || permissions.type !== "array") throw new SettingsError("invalid_config")
    const count = permissions.children?.length ?? 0
    if (patch.op === "insert-rule") {
        const index = patch.index ?? count
        if (index > count) return invalidRequest()
        const created = createNode(raw, ["permissions", index], { action: "external_directory", resource: patch.resource, effect: patch.effect }, index)
        return setNode(created, ["permissions", index, "resource"], patch.resource)
    }
    if (patch.index >= count) return invalidRequest()
    const path = ["permissions", patch.index] as const
    const row = checkedNode(root, path)
    if (!row || row.type !== "object") return invalidRequest()
    for (const name of ["action", "resource", "effect"]) checkedNode(row, [name])
    if (!externalRule(getNodeValue(row))) return invalidRequest()
    if (patch.op === "remove-rule") {
        const keys = row.children?.map((child): unknown => child.children?.[0]?.value) ?? []
        if (keys.length !== 3 || keys.some((key): boolean => key !== "action" && key !== "resource" && key !== "effect")) {
            throw new SettingsError("invalid_config")
        }
        return removeJsoncNodePreservingComments(raw, path)
    }
    if (patch.resource !== undefined) raw = setNode(raw, [...path, "resource"], patch.resource)
    if (patch.effect !== undefined) raw = setNode(raw, [...path, "effect"], patch.effect)
    return raw
}

function checkGlobalPolicy(root: Node): void {
    const credentials = checkedNode(root, ["credentials"])
    if (credentials?.type === "object") checkedNode(credentials, ["provider"])
    const ac = checkedNode(root, ["autocode"])
    if (ac?.type === "object") checkedNode(ac, ["credentials"])
    try {
        validateGlobalCredentialDocument(getNodeValue(root))
    } catch {
        throw new SettingsError("invalid_config")
    }
}

function editDocument(raw: string, patches: SettingsPatch[], global: boolean): string {
    tree(raw)
    for (const patch of patches) {
        if (patch.op === "set" || patch.op === "remove") {
            if (!allowedLeaf(patch.path, global)) return invalidRequest()
            checkProviderPath(raw, patch.path)
            if (patch.op === "set") {
                if (!allowedValue(patch.path, patch.value)) return invalidRequest()
                raw = setNode(raw, patch.path, patch.value)
            } else raw = removeNode(raw, patch.path)
        } else raw = editRule(raw, patch)
        tree(raw)
    }
    const final = tree(raw)
    if (global) checkGlobalPolicy(final)
    return raw
}

function missing(error: unknown): boolean {
    return record(error) && error.code === "ENOENT"
}

function safeParent(file: string, create: boolean): boolean {
    const parent = dirname(file)
    if (!isAbsolute(parent)) throw new SettingsError("io_error")
    const root = parsePath(parent).root
    const parts = relative(root, parent).split(sep).filter(Boolean)
    let current = root
    for (const part of parts) {
        if (part === "..") throw new SettingsError("io_error")
        current = join(current, part)
        let info: ReturnType<typeof lstatSync>
        try {
            info = lstatSync(current)
        } catch (error: unknown) {
            if (!missing(error)) throw error
            if (!create) return false
            try {
                mkdirSync(current, { mode: 0o700 })
            } catch (mkdirError: unknown) {
                if (!record(mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError
            }
            info = lstatSync(current)
        }
        if (info.isSymbolicLink() || !info.isDirectory()) throw new SettingsError("io_error")
    }
    return true
}

type DiskState = { bytes: Buffer | null; mode?: number }

function diskState(file: string): DiskState {
    if (!safeParent(file, false)) return { bytes: null }
    let before: ReturnType<typeof lstatSync>
    try {
        before = lstatSync(file)
    } catch (error: unknown) {
        if (missing(error)) return { bytes: null }
        throw error
    }
    if (before.isSymbolicLink() || !before.isFile()) throw new SettingsError("io_error")
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    const descriptor = openSync(file, flags)
    try {
        const opened = fstatSync(descriptor)
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new SettingsError("conflict")
        const bytes = readFileSync(descriptor)
        const after = fstatSync(descriptor)
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new SettingsError("conflict")
        return { bytes, mode: opened.mode & 0o777 }
    } finally {
        closeSync(descriptor)
    }
}

function sameDisk(left: DiskState, right: DiskState): boolean {
    return left.bytes === null ? right.bytes === null
        : right.bytes !== null && left.mode === right.mode && left.bytes.equals(right.bytes)
}

function targetCandidate(context: SettingsContext, scopeId: string): AutocodeConfigCandidate {
    const candidates = enumerateAutocodeConfigCandidates(context)
    const candidate = candidates.find((item): boolean => settingsScopeId(item.path) === scopeId)
    if (!candidate) return invalidRequest()
    const expected = candidate.roles.includes("global")
        ? join(candidate.scopeRoot, "autocode.jsonc")
        : join(candidate.scopeRoot, ".opencode", "autocode.jsonc")
    if (normalizedFile(candidate.path) !== normalizedFile(expected)) throw new SettingsError("io_error")
    return candidate
}

function decodeDocument(bytes: Buffer | null): string {
    if (bytes === null) return "{}\n"
    try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
        throw new SettingsError("invalid_config")
    }
}

function commit(file: string, initial: DiskState, contents: string): void {
    safeParent(file, true)
    const temporary = join(dirname(file), `.autocode-settings-${randomBytes(16).toString("hex")}.tmp`)
    let created = false
    try {
        const descriptor = openSync(temporary, "wx", initial.mode ?? 0o600)
        created = true
        try {
            if (initial.mode !== undefined) fchmodSync(descriptor, initial.mode)
            writeFileSync(descriptor, contents, "utf8")
        } finally {
            closeSync(descriptor)
        }
        if (!sameDisk(initial, diskState(file))) throw new SettingsError("conflict")
        // External writers can still race between this comparison and the atomic commit.
        if (initial.bytes === null) {
            try {
                linkSync(temporary, file)
            } catch (error: unknown) {
                if (record(error) && error.code === "EEXIST") throw new SettingsError("conflict")
                throw error
            }
        } else renameSync(temporary, file)
    } finally {
        if (created) {
            try {
                unlinkSync(temporary)
            } catch (error: unknown) {
                if (!missing(error)) throw error
            }
        }
    }
}

async function performUpdate(context: SettingsContext, input: SettingsUpdateInput): Promise<SettingsSnapshot> {
    const candidate = targetCandidate(context, input.scopeId)
    const initial = diskState(candidate.path)
    if (settingsRevision(candidate.path, initial.bytes) !== input.revision) throw new SettingsError("conflict")
    const original = decodeDocument(initial.bytes)
    const updated = editDocument(original, input.patches, candidate.roles.includes("global"))
    if (updated === original) {
        if (!sameDisk(initial, diskState(candidate.path))) throw new SettingsError("conflict")
    } else commit(candidate.path, initial, updated)
    return readSettings(context)
}

export async function updateSettings(context: SettingsContext, input: unknown): Promise<SettingsSnapshot> {
    let request: SettingsUpdateInput
    try {
        validateContext(context)
        request = parseUpdate(input)
    } catch (error: unknown) {
        if (error instanceof SettingsError) throw error
        throw new SettingsError("invalid_request")
    }
    const operation = settingsLock.then(async (): Promise<SettingsSnapshot> => {
        try {
            return await performUpdate(context, request)
        } catch (error: unknown) {
            if (error instanceof SettingsError) throw error
            throw new SettingsError("io_error")
        }
    })
    settingsLock = operation.then((): void => {}, (): void => {})
    return operation
}
