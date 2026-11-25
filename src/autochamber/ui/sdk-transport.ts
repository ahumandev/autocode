import type { HostClient, GuestRequest } from "@openchamber/sdk"
import type { SettingsEffectiveValue, SettingsOrigin, SettingsPatch, SettingsScope, SettingsSnapshot as ServiceSettings } from "../settings.js"
import type { CredentialProfileList, CredentialServiceProvider } from "../credentials.js"
import { MODEL_TIERS, PROFILE_FIELDS } from "./transport.js"
import type {
    AutoChamberTransport, DirectoryEntry, ModelTier, ProfileKind, ProfileSummary, ProfileWrite,
    ProfilesSnapshot, ProviderTiersView, ResolvedProvider, ScopeSettings, ScopeView, SettingWrite,
    SettingsSnapshot, TierField, TierViews, UiIssueCode, UiResult, ValueView,
} from "./transport.js"

type Scalar = string | number | boolean
type ScopeContext = { revision: string; rules: readonly DirectoryEntry[]; permissionCount: number; writable: boolean; roles: readonly ScopeView["role"][] }
type ProfileContext = { providers: ReadonlySet<ResolvedProvider>; rows: readonly ProfileSummary[] }

const SCALAR_PATHS: Record<string, string[]> = {
    tierSelector: ["autocode", "tier"],
    syncMethod: ["autocode", "sandbox", "sync_method"],
    distroCachePath: ["autocode", "sandbox", "distro", "cache_path"],
    distroExpire: ["autocode", "sandbox", "distro", "expire"],
    skillsFreeze: ["autocode", "skills", "freeze"],
    memoryDirectory: ["autocode", "memory", "directory"],
    credentialsProvider: ["credentials", "provider"],
}

function object(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function failure<T>(code: UiIssueCode): UiResult<T> {
    return { ok: false, issue: { code } }
}

function errorCode(code: unknown, status: number): UiIssueCode {
    switch (code) {
        case "conflict": case "stale_revision": case "profile_drift": case "duplicate_profile": return "conflict"
        case "profile_shadowed": return "shadowed"
        case "profile_not_found": return "missing"
        case "provider_not_allowed": return "provider-denied"
        case "provider_unavailable": return "provider-unavailable"
        case "io_error": return "unavailable"
        case "invalid_config": return "read-only"
        case "invalid_request": case "confirmation_required": case "plaintext_confirmation_required": return "invalid"
        case "write_failed": return "failed"
        default: return status === 404 ? "missing" : status === 413 ? "too-large" : "unavailable"
    }
}

async function request(host: Pick<HostClient, "serviceRequest">, input: GuestRequest): Promise<UiResult<unknown>> {
    try {
        const response = await host.serviceRequest(input)
        let data: unknown
        try { data = JSON.parse(response.body) as unknown } catch { data = undefined }
        if (response.status < 200 || response.status >= 300) {
            return failure(errorCode(object(data) && object(data.error) ? data.error.code : undefined, response.status))
        }
        if (response.status !== (input.method === "POST" && input.path === "/profiles" ? 201 : 200)) return failure("invalid")
        if (object(data) && data.ok === false) {
            return failure(errorCode(object(data.error) ? data.error.code : undefined, response.status))
        }
        return { ok: true, value: data }
    } catch {
        return failure("unavailable")
    }
}

function provider(value: CredentialServiceProvider): ResolvedProvider | undefined {
    if (value === "windows") return "windows-credential-manager"
    if (value === "linux") return "linux-secret-service"
    if (value === "plaintext") return "plaintext"
    return undefined
}

function serviceProvider(value: ResolvedProvider): CredentialServiceProvider {
    if (value === "windows-credential-manager") return "windows"
    if (value === "linux-secret-service") return "linux"
    return "plaintext"
}

function origin(value: SettingsOrigin | null | undefined): string | undefined {
    if (!value) return undefined
    return `${value.file} [${value.path.join(".")}]${value.scopeId ? ` (${value.scopeId})` : ""}`
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((part, index): boolean => part === right[index])
}

function validOrigin(value: unknown): boolean {
    return value === null || (object(value) && typeof value.file === "string" && Array.isArray(value.path)
        && value.path.every((part: unknown): boolean => typeof part === "string" || Number.isSafeInteger(part))
        && (value.scopeId === null || typeof value.scopeId === "string"))
}

function validEffective(value: unknown): boolean {
    if (value === null) return true
    if (!object(value) || !Array.isArray(value.values) || !Array.isArray(value.externalDirectory)) return false
    for (const item of value.values) {
        if (!object(item) || !Array.isArray(item.path) || !item.path.every((part: unknown): boolean => typeof part === "string")
            || !(item.value === null || typeof item.value === "string" || typeof item.value === "boolean"
                || (typeof item.value === "number" && Number.isFinite(item.value)))
            || !validOrigin(item.source) || !Array.isArray(item.overridden) || !item.overridden.every(validOrigin)
            || (item.cause !== undefined && !validOrigin(item.cause))) return false
    }
    for (const rule of value.externalDirectory) {
        if (!object(rule) || typeof rule.resource !== "string" || !["allow", "deny", "ask"].includes(String(rule.effect))
            || !validOrigin(rule.source) || !Array.isArray(rule.overridden) || !rule.overridden.every(validOrigin)) return false
    }
    return true
}

function valueView<T extends Scalar>(scope: SettingsScope, effective: readonly SettingsEffectiveValue[], path: string[]): ValueView<T> {
    const raw = scope.values.find((item): boolean => samePath(item.path, path))
    const resolved = effective.find((item): boolean => samePath(item.path, path))
    const source = origin(resolved?.source)
    const state = raw ? resolved?.source?.scopeId === scope.id ? "local" : "overridden"
        : resolved?.value !== null && resolved?.value !== undefined ? "inherited" : "unset"
    return {
        ...(raw ? { raw: raw.value as T } : {}),
        ...(resolved?.value !== null && resolved?.value !== undefined ? { effective: resolved.value as T } : {}),
        ...(source === undefined ? {} : { source }),
        state,
        ...(resolved ? { overridden: resolved.overridden.map(origin).filter((item): item is string => item !== undefined) } : {}),
        ...(resolved?.cause ? { cause: origin(resolved.cause) } : {}),
        ...(raw?.legacy ? { legacyStatus: raw.legacy } : {}),
    }
}

function tiers(scope: SettingsScope, effective: readonly SettingsEffectiveValue[], prefix: string[], legacy = false): TierViews {
    const result: Partial<Record<ModelTier, Partial<Record<TierField, ValueView<string>>>>> = {}
    for (const tier of MODEL_TIERS) {
        const fields: Partial<Record<TierField, ValueView<string>>> = {}
        for (const field of ["model", "variant"] as const) {
            fields[field] = valueView<string>(scope, effective, legacy ? ["autocode", field, tier] : [...prefix, tier, field])
        }
        result[tier] = fields
    }
    return result
}

function scopeSettings(scope: SettingsScope, effective: ServiceSettings["effective"]): ScopeSettings {
    const values = effective?.values ?? []
    const names = new Set<string>()
    for (const item of [...scope.values, ...values]) {
        const path = item.path
        if (path.length === 5 && path[0] === "autocode" && path[1] === "tiers"
            && !["__proto__", "prototype", "constructor", ...MODEL_TIERS].includes(path[2])) names.add(path[2])
    }
    const providerTiers: ProviderTiersView[] = [...names].map((name): ProviderTiersView => ({
        provider: name, tiers: tiers(scope, values, ["autocode", "tiers", name]),
    }))
    const raw: DirectoryEntry[] = scope.externalDirectory.map((rule): DirectoryEntry => ({
        id: String(rule.index), resource: rule.resource, effect: rule.effect, source: scope.file, state: "local",
    }))
    const resolved: DirectoryEntry[] | undefined = effective?.externalDirectory.map((rule, index): DirectoryEntry => ({
        id: String(index), resource: rule.resource, effect: rule.effect,
        ...(origin(rule.source) ? { source: origin(rule.source) } : {}), state: "inherited",
    }))
    return {
        tierSelector: valueView(scope, values, SCALAR_PATHS.tierSelector),
        directTiers: tiers(scope, values, ["autocode", "tiers"]),
        providerTiers,
        legacyTiers: tiers(scope, values, [], true),
        resolvedTiers: tiers({ ...scope, values: [] }, values, ["autocode", "tiers"]),
        syncMethod: valueView(scope, values, SCALAR_PATHS.syncMethod),
        distroCachePath: valueView(scope, values, SCALAR_PATHS.distroCachePath),
        distroExpire: valueView(scope, values, SCALAR_PATHS.distroExpire),
        skillsFreeze: valueView(scope, values, SCALAR_PATHS.skillsFreeze),
        memoryDirectory: valueView(scope, values, SCALAR_PATHS.memoryDirectory),
        credentialsProvider: valueView(scope, values, SCALAR_PATHS.credentialsProvider),
        externalDirectories: {
            raw, ...(resolved ? { effective: resolved } : {}),
            ...(effective ? { overridden: effective.externalDirectory.flatMap((rule): string[] =>
                rule.overridden.map(origin).filter((item): item is string => item !== undefined)) } : {}),
            state: raw.length ? "local" : resolved?.length ? "inherited" : "unset",
        },
    }
}

function settingsSnapshot(data: unknown): SettingsSnapshot | undefined {
    if (!object(data) || !Array.isArray(data.scopes) || !validEffective(data.effective)) return undefined
    const ids = new Set<string>()
    for (const scope of data.scopes) {
        if (!object(scope) || typeof scope.id !== "string" || typeof scope.file !== "string"
            || typeof scope.scopeRoot !== "string" || !Array.isArray(scope.roles) || !Array.isArray(scope.values)
            || !Array.isArray(scope.externalDirectory) || !Number.isSafeInteger(scope.permissionCount) || (scope.permissionCount as number) < 0
            || !(scope.revision === null || typeof scope.revision === "string")
            || !["missing", "valid", "invalid", "unreadable"].includes(String(scope.state))) return undefined
        if (!scope.id || ids.has(scope.id) || scope.roles.length === 0
            || scope.roles.some((role: unknown): boolean => !["global", "worktree", "intermediate", "active"].includes(String(role)))) return undefined
        ids.add(scope.id)
        for (const item of scope.values) {
            if (!object(item) || !Array.isArray(item.path) || !item.path.every((part: unknown): boolean => typeof part === "string")
                || !(typeof item.value === "string" || typeof item.value === "boolean"
                    || (typeof item.value === "number" && Number.isFinite(item.value)))
                || (item.legacy !== undefined && !["used", "overridden", "ignored", "unresolved"].includes(String(item.legacy)))) return undefined
        }
        const indices = new Set<number>()
        for (const rule of scope.externalDirectory) {
            if (!object(rule) || !Number.isSafeInteger(rule.index) || (rule.index as number) < 0
                || (rule.index as number) >= (scope.permissionCount as number) || indices.has(rule.index as number)
                || typeof rule.resource !== "string" || !["allow", "deny", "ask"].includes(String(rule.effect))) return undefined
            indices.add(rule.index as number)
        }
    }
    const snapshot = data as unknown as ServiceSettings
    const scopes: ScopeView[] = snapshot.scopes.map((scope): ScopeView => {
        const roles = scope.roles.filter((role): role is ScopeView["role"] =>
            role === "global" || role === "worktree" || role === "intermediate" || role === "active")
        const revision = typeof scope.revision === "string" && scope.revision ? scope.revision : undefined
        return {
            id: scope.id, role: roles[0] ?? "global", roles, source: scope.file, scopeRoot: scope.scopeRoot,
            scopeState: scope.state, permissionCount: scope.permissionCount,
            writable: revision !== undefined && roles.length > 0 && scope.state !== "invalid" && scope.state !== "unreadable" && !snapshot.issue && snapshot.effective !== null,
            ...(revision ? { revision } : {}),
            ...(snapshot.issue ? { issue: { code: "read-only" as const } } : {}),
            settings: scopeSettings(scope, snapshot.effective),
        }
    })
    const notice = object(data.notice) && data.notice.code === "no_active_directory"
        ? "No active directory. Showing global settings."
        : object(data.notice) && data.notice.code === "unverified_project"
            ? "Active directory has no verified project root. Showing global settings." : undefined
    const active = scopes.find((scope): boolean => scope.roles?.includes("active") === true)
    const worktree = scopes.find((scope): boolean => scope.roles?.includes("worktree") === true)
    return {
        scopes, ...(active ? { activeScopeId: active.id, directory: active.scopeRoot } : {}),
        ...(worktree ? { worktree: worktree.scopeRoot } : {}), ...(notice ? { notice } : {}),
    }
}

function profileSnapshot(data: unknown): ProfilesSnapshot | undefined {
    if (!object(data) || data.ok !== true || !object(data.data)
        || !Array.isArray(data.data.profiles) || !Array.isArray(data.data.providers)) return undefined
    const list = data.data as unknown as CredentialProfileList
    const providers: NonNullable<ProfilesSnapshot["providers"]>[number][] = []
    const seen = new Set<ResolvedProvider>()
    for (const item of list.providers) {
        if (!object(item) || typeof item.readOnly !== "boolean" || typeof item.unavailable !== "boolean") return undefined
        const name = provider(item.provider)
        if (!name) continue
        if (seen.has(name)) return undefined
        seen.add(name)
        providers.push({ provider: name, writable: !item.readOnly && !item.unavailable, issues: item.unavailable ? [{ code: "provider-unavailable" }] : item.readOnly ? [{ code: "read-only" }] : [] })
    }
    const profiles: ProfileSummary[] = []
    for (const row of list.profiles) {
        if (!object(row) || (row.kind !== "rest" && row.kind !== "ssh" && row.kind !== "db")
            || typeof row.id !== "string" || typeof row.readOnly !== "boolean" || typeof row.unavailable !== "boolean" || !object(row.configured)) return undefined
        const name = provider(row.provider)
        if (!name) continue
        const summary = {
            id: row.id, provider: name,
            writable: !row.readOnly && !row.unavailable && typeof row.revision === "string" && row.revision.length > 0,
            issues: row.unavailable ? [{ code: "provider-unavailable" as const }] : row.readOnly ? [{ code: "read-only" as const }] : [],
            ...(typeof row.revision === "string" && row.revision ? { revision: row.revision } : {}),
        }
        const configured = row.configured
        if (row.kind === "rest") {
            profiles.push({ ...summary, kind: "rest", fields: {
                authorization: configured.authorization === true, username: configured.username === true, password: configured.password === true,
            } })
        } else if (row.kind === "ssh") {
            profiles.push({ ...summary, kind: "ssh", fields: {
                host: configured.host === true, username: configured.username === true, port: configured.port === true,
                keyfile: configured.keyfile === true, agent: configured.agent === true, password: configured.password === true,
                keypass: configured.keypass === true,
            } })
        } else {
            profiles.push({ ...summary, kind: "db", fields: {
                connection: configured.connection === true, username: configured.username === true, password: configured.password === true,
            } })
        }
    }
    return { profiles, providers, writable: providers.some((item): boolean => item.writable), issues: [], plaintextDisposition: "unknown" }
}

function settingPatches(change: SettingWrite["change"], context: ScopeContext): SettingsPatch[] | undefined {
    if (change.kind === "scalar") {
        const path = SCALAR_PATHS[change.key]
        if (!path || (change.key === "credentialsProvider" && !context.roles.includes("global"))) return undefined
        return [change.op === "set" ? { op: "set", path, value: change.value } : { op: "remove", path }]
    }
    if (change.kind === "tier") {
        if (change.map.kind === "legacy" || !MODEL_TIERS.includes(change.tier) || !["model", "variant"].includes(change.field)) return undefined
        const name = change.map.kind === "provider" ? change.map.provider : undefined
        if (name !== undefined && (!name || ["__proto__", "prototype", "constructor", ...MODEL_TIERS].includes(name) || name.includes("\0"))) return undefined
        const path = ["autocode", "tiers", ...(name === undefined ? [] : [name]), change.tier, change.field]
        return [change.op === "set" ? { op: "set", path, value: change.value } : { op: "remove", path }]
    }
    if (change.op === "append") return [{ op: "insert-rule", resource: change.resource, effect: change.effect }]
    const position = context.rules.findIndex((rule): boolean => rule.id === change.id)
    if (position < 0) return undefined
    const index = Number(context.rules[position].id)
    if (!Number.isSafeInteger(index) || index < 0 || index >= context.permissionCount) return undefined
    if (change.op === "remove") return [{ op: "remove-rule", index }]
    if (change.op === "update") return [{ op: "update-rule", index, resource: change.resource, effect: change.effect }]
    const neighbor = context.rules[position + (change.direction === "up" ? -1 : 1)]
    if (!neighbor) return undefined
    const neighborIndex = Number(neighbor.id)
    if (!Number.isSafeInteger(neighborIndex) || neighborIndex < 0 || neighborIndex >= context.permissionCount) return undefined
    const rule = context.rules[position]
    return [{ op: "remove-rule", index }, { op: "insert-rule", index: neighborIndex, resource: rule.resource, effect: rule.effect }]
}

export function createSdkTransport(host: Pick<HostClient, "serviceRequest">, directory: string | null): AutoChamberTransport {
    let scopes = new Map<string, ScopeContext>()
    let profiles: ProfileContext | undefined
    return {
        async readSettings(): Promise<UiResult<SettingsSnapshot>> {
            scopes.clear()
            if (directory === "") return failure("invalid")
            const result = await request(host, { method: "GET", path: "/settings", ...(directory !== null ? { query: { directory } } : {}) })
            if (!result.ok) return result
            try {
                const snapshot = settingsSnapshot(result.value)
                if (!snapshot) return failure("invalid")
                for (const scope of snapshot.scopes) if (scope.revision) scopes.set(scope.id, {
                    revision: scope.revision, rules: scope.settings.externalDirectories?.raw ?? [], permissionCount: scope.permissionCount ?? 0,
                    writable: scope.writable, roles: scope.roles ?? [],
                })
                return { ok: true, value: snapshot }
            } catch { return failure("invalid") }
        },
        async writeSetting(input: SettingWrite): Promise<UiResult<void>> {
            const scope = scopes.get(input.scopeId)
            if (!scope || !scope.writable || !input.revision || scope.revision !== input.revision) return failure("conflict")
            const patches = settingPatches(input.change, scope)
            if (!patches) return failure("invalid")
            scopes.clear()
            const result = await request(host, { method: "PATCH", path: "/settings", body: JSON.stringify({
                ...(directory !== null ? { directory } : {}), scopeId: input.scopeId, revision: input.revision, patches,
            }) })
            if (!result.ok) return result
            try {
                return settingsSnapshot(result.value) ? { ok: true, value: undefined } : failure("invalid")
            } catch { return failure("invalid") }
        },
        async readProfiles(): Promise<UiResult<ProfilesSnapshot>> {
            profiles = undefined
            const result = await request(host, { method: "GET", path: "/profiles" })
            if (!result.ok) return result
            try {
                const snapshot = profileSnapshot(result.value)
                if (!snapshot) return failure("invalid")
                profiles = { providers: new Set(snapshot.providers?.filter((item): boolean => item.writable).map((item): ResolvedProvider => item.provider)), rows: snapshot.profiles }
                return { ok: true, value: snapshot }
            } catch { return failure("invalid") }
        },
        async writeProfile(input: ProfileWrite): Promise<UiResult<void>> {
            if (!profiles || input.confirmed !== true || !profiles.providers.has(input.provider)
                || (input.provider === "plaintext" && input.plaintextConsent !== true)) return failure("writer-unavailable")
            if (input.mode === "update" && !profiles.rows.some((row): boolean => row.kind === input.kind && row.id === input.id
                && row.provider === input.provider && row.writable && !!input.revision && row.revision === input.revision)) return failure("conflict")
            const fields: Record<string, string | { op: "keep" | "clear" } | { op: "set"; value: string }> = {}
            const permitted: readonly string[] = PROFILE_FIELDS[input.kind as ProfileKind]
            for (const [field, operation] of Object.entries(input.fields)) {
                if (!permitted.includes(field) || !operation) return failure("invalid")
                if (operation.op === "set" && typeof operation.value === "string") fields[field] = input.mode === "create" ? operation.value : { op: "set", value: operation.value }
                else if (input.mode === "update" && (operation.op === "keep" || operation.op === "clear")) fields[field] = { op: operation.op }
                else return failure("invalid")
            }
            profiles = undefined
            const result = await request(host, { method: input.mode === "create" ? "POST" : "PATCH", path: "/profiles", body: JSON.stringify({
                kind: input.kind, id: input.id, provider: serviceProvider(input.provider), fields,
                ...(input.mode === "update" ? { revision: input.revision, confirm: true } : {}),
                ...(input.provider === "plaintext" ? { confirmPlaintext: true } : {}),
            }) })
            if (!result.ok) return result
            return object(result.value) && result.value.ok === true && object(result.value.data)
                ? { ok: true, value: undefined } : failure("invalid")
        },
    }
}
