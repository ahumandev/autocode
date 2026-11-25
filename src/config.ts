import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Buffer } from "node:buffer"

import defaultAutocodeConfig from "./default-autocode.jsonc" with { type: "json" }
import { resolveOpenCodePaths } from "./utils/paths"
import { createJsoncDocumentEditor } from "./tools/config/json"
import type { PermissionRule } from "./utils/permissions"
import { CREDENTIAL_PROVIDER_POLICIES, isCredentialProviderPolicy, type CredentialPolicy } from "./credentials/types"
import { DEFAULT_MEMORY_DIRECTORY } from "./utils/memory_directory"

const MODEL_TIERS = ["cheap", "fast", "operator", "context", "balanced", "smart", "spy"] as const
const PERMISSION_ACTIONS = ["ask", "allow", "deny"] as const
const SANDBOX_SYNC_METHODS = ["auto", "overlayfs", "reflink", "copy"] as const
const DEFAULT_CREDENTIAL_PROVIDER = "auto"
const SKILL_CATEGORIES: readonly SkillCategory[] = ["bash", "code", "design", "test"]

export type ModelTier = (typeof MODEL_TIERS)[number]
export type TierConfig = { model?: string; variant?: string }
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]
export type ExternalDirectoryRules = Record<string, PermissionAction>
export type SandboxSyncMethod = (typeof SANDBOX_SYNC_METHODS)[number]
export type AutocodeSandboxConfig = {
    sync_method?: SandboxSyncMethod
    distro_cache_path?: string
    distro_expire?: string | number
}
export type AutocodeMemoryConfig = { directory: string }

export type SkillCategory = "bash" | "code" | "design" | "test"
export type SkillsConfig = Partial<Record<SkillCategory, string[]>> & { freeze?: boolean }
const DEFAULT_SKILLS: SkillsConfig = { ...defaultAutocodeConfig.autocode.skills }

export type AutocodeConfig = {
    tiers: Partial<Record<ModelTier, TierConfig>>
    externalDirectories: ExternalDirectoryRules
    externalDirectoryPermissions: PermissionRule[]
    sandbox: AutocodeSandboxConfig
    skills: SkillsConfig | undefined
    memory: AutocodeMemoryConfig
    credentials: CredentialPolicy
}
export type AutocodeConfigRole = "global" | "worktree" | "intermediate" | "active"
export type AutocodeConfigCandidate = {
    path: string
    scopeRoot: string
    roles: AutocodeConfigRole[]
    kind: "autocode"
}
export type AutocodeConfigCandidateDetail = AutocodeConfigCandidate & (
    | { state: "missing" | "unreadable" }
    | { state: "invalid"; bytes: Buffer; raw: string; document?: unknown }
    | { state: "valid"; bytes: Buffer; raw: string; document: unknown }
)
export type AutocodeConfigOrigin = { file: string; path: (string | number)[] }
export type AutocodeConfigTraceEvent = {
    target: (string | number)[]
    action: "set" | "clear" | "replace" | "append" | "ignored"
    origin?: AutocodeConfigOrigin
    cause?: AutocodeConfigOrigin
    permission?: { resource: string; effect: PermissionAction }
}
export type AutocodeTierSource = {
    file: string
    tier?: unknown
    tiers?: unknown
    model?: unknown
    variant?: unknown
}
export type AutocodeTierResolution = {
    selectedProvider?: string
    selectedProviderOrigin?: AutocodeConfigOrigin
    providerTiers: Record<string, Partial<Record<ModelTier, TierConfig>>>
}
export type AutocodeConfigDetails = {
    config?: AutocodeConfig
    candidates: AutocodeConfigCandidateDetail[]
    trace: AutocodeConfigTraceEvent[]
    tierSources: AutocodeTierSource[]
    tierResolution?: AutocodeTierResolution
    failure?: { kind: "invalid" | "unreadable"; file: string }
}

export interface ConfigFileSystem {
    readFileSync(path: string, encoding: "utf-8"): string
    ensureFileSync(path: string, contents: string): void
    writeFileSync(path: string, contents: string): void
}

const defaultFs: ConfigFileSystem = {
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    ensureFileSync(path, contents) {
        if (existsSync(path)) {
            return
        }

        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, contents)
    },
    writeFileSync: (path, contents) => writeFileSync(path, contents),
}

const DEFAULT_AUTOCODE_CONFIG = `${JSON.stringify(
        {
            ...defaultAutocodeConfig,
            autocode: {
                ...defaultAutocodeConfig.autocode,
                skills: DEFAULT_SKILLS,
            },
        },
        null,
        4,
    )}\n`

type AutocodeJsoncNew = {
    autocode?: {
        tier?: unknown
        tiers?: Record<string, unknown>
        sandbox?: unknown
        skills?: unknown
        memory?: unknown
    }
    credentials?: unknown
    permissions?: unknown
}

type AutocodeJsoncLegacy = {
    autocode?: {
        model?: Partial<Record<ModelTier, string>>
        variant?: Partial<Record<ModelTier, string>>
    }
}

type ParsedAutocodeConfig = {
    tier?: string
    tiers?: Record<string, unknown>
    legacyTiers?: Partial<Record<ModelTier, TierConfig>>
    externalDirectories?: ExternalDirectoryRules
    externalDirectoryPermissions?: PermissionRule[]
    sandbox?: AutocodeSandboxConfig
    skills?: SkillsConfig
    memory?: AutocodeMemoryConfig
    credentials?: CredentialPolicy
}

function stripJsoncComments(raw: string): string {
    // Remove single-line (//) and block (/* */) comments outside strings
    // https://www.rfc-editor.org/rfc/rfc8259 — minimal JSONC stripper
    let result = ""
    let i = 0
    while (i < raw.length) {
        if (raw[i] === '"') {
            // string literal: copy until closing unescaped quote
            result += raw[i++]
            while (i < raw.length) {
                const ch = raw[i]
                result += ch
                if (ch === "\\" && i + 1 < raw.length) {
                    i++
                    result += raw[i]
                } else if (ch === '"') {
                    break
                }
                i++
            }
            i++
            continue
        }
        if (raw[i] === "/" && raw[i + 1] === "/") {
            // line comment
            while (i < raw.length && raw[i] !== "\n") i++
            continue
        }
        if (raw[i] === "/" && raw[i + 1] === "*") {
            // block comment
            i += 2
            while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++
            i += 2
            continue
        }
        result += raw[i++]
    }
    // Strip trailing commas before } or ] (JSONC allows them)
    return result.replace(/,(\s*[}\]])/g, "$1")
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function collectTiers(value: unknown): Partial<Record<ModelTier, TierConfig>> | undefined {
    if (!isRecord(value)) return undefined

    const result: Partial<Record<ModelTier, TierConfig>> = {}
    for (const tier of MODEL_TIERS) {
        const config = value[tier]
        if (isRecord(config)) result[tier] = config as TierConfig
    }

    return Object.keys(result).length > 0 ? result : undefined
}

export function collectExternalDirectories(value: unknown): ExternalDirectoryRules | undefined {
    const result: ExternalDirectoryRules = {}
    for (const rule of collectExternalDirectoryPermissions(value)) {
        if (rule.resource in result) delete result[rule.resource]
        result[rule.resource] = rule.effect
    }

    return Object.keys(result).length > 0 ? result : undefined
}

export function collectExternalDirectoryPermissions(value: unknown): PermissionRule[] {
    if (!Array.isArray(value)) return []
    return value.filter((rule): rule is PermissionRule => isRecord(rule)
        && rule.action === "external_directory" && typeof rule.resource === "string"
        && PERMISSION_ACTIONS.includes(rule.effect as PermissionAction))
}

function collectSandboxConfig(value: unknown): AutocodeSandboxConfig | undefined {
    if (!isRecord(value)) return undefined
    const result: AutocodeSandboxConfig = {}
    if (typeof value.sync_method === "string" && SANDBOX_SYNC_METHODS.includes(value.sync_method as SandboxSyncMethod)) {
        result.sync_method = value.sync_method as SandboxSyncMethod
    }
    if (isRecord(value.distro)) {
        if (typeof value.distro.cache_path === "string") result.distro_cache_path = value.distro.cache_path
        if (typeof value.distro.expire === "string" || typeof value.distro.expire === "number") result.distro_expire = value.distro.expire
    }
    return Object.keys(result).length > 0 ? result : undefined
}

function collectMemoryConfig(value: unknown): AutocodeMemoryConfig | undefined {
    if (!isRecord(value) || typeof value.directory !== "string" || !value.directory.trim()) return undefined
    return { directory: value.directory }
}

function collectSkills(value: unknown, quiet: boolean = false): SkillsConfig | undefined {
    if (value === undefined) return undefined
    if (!isRecord(value)) {
        if (!quiet) console.warn(`autocode: invalid skills config (expected object, got ${Array.isArray(value) ? "array" : typeof value})`)
        return undefined
    }
    const result: SkillsConfig = {}
    if ("freeze" in value) {
        if (typeof value.freeze !== "boolean") {
            if (!quiet) console.warn(`autocode: invalid skills.freeze (expected boolean, got ${JSON.stringify(value.freeze)}); falling back to false`)
            result.freeze = false
        } else {
            result.freeze = value.freeze
        }
    }
    if (!quiet && SKILL_CATEGORIES.some((category) => Array.isArray(value[category]))) {
        warnLegacySkillsConfig()
    }

    return Object.keys(result).length > 0 ? result : undefined
}

let didWarnLegacySkillsConfig = false

function warnLegacySkillsConfig(): void {
    if (didWarnLegacySkillsConfig) return
    didWarnLegacySkillsConfig = true
    console.warn("autocode: legacy skills category arrays are deprecated and ignored")
}

export function mergeExternalDirectoryRules(base: ExternalDirectoryRules, next: ExternalDirectoryRules): ExternalDirectoryRules {
    const merged: ExternalDirectoryRules = { ...base }

    for (const [pattern, action] of Object.entries(next)) {
        if (pattern in merged) {
            delete merged[pattern]
        }

        merged[pattern] = action
    }

    return merged
}

function collectCredentialPolicy(value: unknown): CredentialPolicy {
    if (value === undefined) return { provider: DEFAULT_CREDENTIAL_PROVIDER }
    if (isRecord(value) && Object.keys(value).every((key: string): boolean => key === "provider")) {
        const provider = Object.hasOwn(value, "provider") ? value.provider : DEFAULT_CREDENTIAL_PROVIDER
        if (isCredentialProviderPolicy(provider)) return { provider }
    }

    throw new Error(`autocode: invalid global autocode.jsonc credentials policy; supported top-level credentials.provider values: ${CREDENTIAL_PROVIDER_POLICIES.join(", ")}`)
}

export function validateGlobalCredentialDocument(document: unknown): CredentialPolicy {
    const root = document as (AutocodeJsoncNew & AutocodeJsoncLegacy) | null | undefined
    const ac = root?.autocode
    if (isRecord(ac) && Object.hasOwn(ac, "credentials")) {
        throw new Error("autocode: global autocode.jsonc does not support autocode.credentials; move policy to top-level credentials.provider.")
    }
    return collectCredentialPolicy(root?.credentials)
}

function parseAutocodeConfig(raw: string, path: string, parseCredentials: boolean = false, quiet: boolean = false): ParsedAutocodeConfig {
    let parsed: AutocodeJsoncNew & AutocodeJsoncLegacy
    try {
        parsed = JSON.parse(stripJsoncComments(raw))
    } catch (err) {
        throw new Error(`autocode: malformed JSONC in ${path}: ${(err as Error).message}`)
    }
    const ac = parsed?.autocode
    const credentials = parseCredentials ? validateGlobalCredentialDocument(parsed) : undefined
    const externalDirectories = collectExternalDirectories(parsed.permissions)
    const externalDirectoryPermissions = collectExternalDirectoryPermissions(parsed.permissions)
    const sandbox = collectSandboxConfig(ac?.sandbox)
    const skills = collectSkills(ac?.skills, quiet)
    const memory = collectMemoryConfig(ac?.memory)

    if (!ac) return { externalDirectories, externalDirectoryPermissions, sandbox, skills, memory, credentials }

    if (isRecord(ac.tiers)) {
        return {
            tier: typeof ac.tier === "string" ? ac.tier : undefined,
            tiers: ac.tiers,
            externalDirectories,
            externalDirectoryPermissions,
            sandbox,
            skills,
            memory,
            credentials,
        }
    }

    if (typeof ac.tier === "string") {
        return { tier: ac.tier, externalDirectories, externalDirectoryPermissions, sandbox, skills, memory, credentials }
    }

    // legacy shape: autocode.model.<tier> + optional autocode.variant.<tier>
    if (ac.model) {
        const result: Partial<Record<ModelTier, TierConfig>> = {}
        for (const tier of MODEL_TIERS) {
            const model = ac.model[tier]
            if (model !== undefined) {
                result[tier] = { model, variant: ac.variant?.[tier] }
            }
        }
        return { legacyTiers: result, externalDirectories, externalDirectoryPermissions, sandbox, skills, memory, credentials }
    }

    return { externalDirectories, externalDirectoryPermissions, sandbox, skills, memory, credentials }
}

function addCandidate(candidates: string[], path: string): void {
    if (!candidates.includes(path)) {
        candidates.push(path)
    }
}

function collectExactLocalConfigCandidates(worktree: string, directory: string): string[] {
    const candidates: string[] = []

    addCandidate(candidates, join(worktree, ".opencode", "autocode.jsonc"))
    if (directory !== worktree) {
        addCandidate(candidates, join(directory, ".opencode", "autocode.jsonc"))
    }

    return candidates
}

function collectLocalConfigCandidates(worktree: string, directory: string): string[] {
    if (!isAbsolute(worktree) || !isAbsolute(directory)) {
        return collectExactLocalConfigCandidates(worktree, directory)
    }

    const candidates: string[] = []
    const resolvedWorktree = resolve(worktree)
    const resolvedDirectory = resolve(directory)
    const relativeDirectory = relative(resolvedWorktree, resolvedDirectory)

    addCandidate(candidates, join(resolvedWorktree, ".opencode", "autocode.jsonc"))

    if (relativeDirectory === "") {
        return candidates
    }

    if (relativeDirectory.startsWith(`..${sep}`) || relativeDirectory === ".." || isAbsolute(relativeDirectory)) {
        return collectExactLocalConfigCandidates(worktree, directory)
    }

    let current = resolvedWorktree
    for (const part of relativeDirectory.split(sep)) {
        current = join(current, part)
        addCandidate(candidates, join(current, ".opencode", "autocode.jsonc"))
    }

    return candidates
}

function collectLocalOpencodeConfigCandidates(worktree: string, directory: string): string[][] {
    return collectLocalConfigCandidates(worktree, directory).map((path) => {
        const configDirectory = dirname(dirname(path))
        return [join(configDirectory, "opencode.jsonc"), join(configDirectory, "opencode.json")]
    })
}

type ConfigCandidateGroup = { paths: string[]; editable?: AutocodeConfigCandidate }

export type AutocodeConfigContext =
    | { worktree: string; directory: string }
    | { worktree?: null | undefined; directory?: null | undefined }

function configCoordinates(context: AutocodeConfigContext): [string, string] | undefined {
    if ((context.worktree === null || context.worktree === undefined)
        && (context.directory === null || context.directory === undefined)) return undefined
    if (typeof context.worktree === "string" && typeof context.directory === "string") return [context.worktree, context.directory]
    throw new Error("Invalid config context")
}

function configCandidateGroups(worktree: string | undefined, directory: string | undefined): ConfigCandidateGroup[] {
    const globalRoot = resolveOpenCodePaths().globalConfigRoot
    if (worktree === undefined && !isAbsolute(globalRoot)) throw new Error("Invalid global config root")
    const globalPath = join(globalRoot, "autocode.jsonc")
    const localPaths = worktree !== undefined && directory !== undefined ? collectLocalConfigCandidates(worktree, directory) : []
    const globalAbsolute = resolve(globalPath)
    const worktreeAbsolute = worktree === undefined ? undefined : resolve(worktree)
    const directoryAbsolute = directory === undefined ? undefined : resolve(directory)
    const editable = (path: string, global: boolean): AutocodeConfigCandidate => {
        const absolute = resolve(path)
        const root = resolve(dirname(dirname(path)))
        const roles: AutocodeConfigRole[] = []
        if (absolute === globalAbsolute) roles.push("global")
        if (worktree !== undefined && root === worktreeAbsolute && (!global || absolute === resolve(join(worktree, ".opencode", "autocode.jsonc")))) roles.push("worktree")
        if (directory !== undefined && root === directoryAbsolute && (!global || absolute === resolve(join(directory, ".opencode", "autocode.jsonc")))) roles.push("active")
        if (!global && !roles.includes("worktree") && !roles.includes("active")) roles.push("intermediate")
        return { path: absolute, scopeRoot: global ? resolve(globalRoot) : root, roles, kind: "autocode" }
    }
    return [
        { paths: [join(globalRoot, "opencode.jsonc"), join(globalRoot, "opencode.json")] },
        { paths: [globalPath], editable: editable(globalPath, true) },
        ...(worktree !== undefined && directory !== undefined ? collectLocalOpencodeConfigCandidates(worktree, directory) : []).map((paths) => ({ paths })),
        ...localPaths.map((path) => ({ paths: [path], editable: editable(path, false) })),
    ]
}

export function enumerateAutocodeConfigCandidates(context: AutocodeConfigContext): AutocodeConfigCandidate[] {
    const coordinates = configCoordinates(context)
    return configCandidateGroups(coordinates?.[0], coordinates?.[1])
        .flatMap((group) => group.editable ? [group.editable] : [])
}

function readFirstConfig(fs: ConfigFileSystem, paths: readonly string[]): { path: string, raw: string } | undefined {
    for (const path of paths) {
        try {
            return { path, raw: fs.readFileSync(path, "utf-8") }
        } catch {
        }
    }
    return undefined
}

function mergeTiers(
    base: Partial<Record<ModelTier, TierConfig>>,
    next: Partial<Record<ModelTier, TierConfig>>,
): Partial<Record<ModelTier, TierConfig>> {
    const merged = { ...base }
    for (const tier of MODEL_TIERS) {
        if (next[tier]) merged[tier] = { ...merged[tier], ...next[tier] }
    }
    return merged
}

function mergeProviderTiers(
    base: Record<string, Partial<Record<ModelTier, TierConfig>>>,
    availableTiers: Record<string, unknown>,
): Record<string, Partial<Record<ModelTier, TierConfig>>> {
    const merged = { ...base }
    for (const [provider, value] of Object.entries(availableTiers)) {
        const providerTiers = collectTiers(value)
        if (providerTiers) merged[provider] = mergeTiers(merged[provider] ?? {}, providerTiers)
    }
    return merged
}

type ProviderOrigins = Record<string, Partial<Record<ModelTier, Partial<Record<"model" | "variant", AutocodeConfigOrigin>>>>>
type TraceRecorder = (target: (string | number)[], action: AutocodeConfigTraceEvent["action"], source?: AutocodeConfigOrigin, cause?: AutocodeConfigOrigin, permission?: AutocodeConfigTraceEvent["permission"]) => void

function traceDirectTiers(tiers: Partial<Record<ModelTier, TierConfig>>, file: string, record: TraceRecorder): void {
    for (const tier of MODEL_TIERS) {
        const value = tiers[tier]
        if (!value) continue
        for (const field of ["model", "variant"] as const) {
            if (Object.hasOwn(value, field)) {
                record(["tiers", tier, field], "set", { file: resolve(file), path: ["autocode", "tiers", tier, field] })
            }
        }
    }
}

function traceSelectedTiers(
    provider: string,
    tiers: Partial<Record<ModelTier, TierConfig>>,
    origins: ProviderOrigins,
    cause: AutocodeConfigOrigin,
    record: TraceRecorder,
): void {
    for (const tier of MODEL_TIERS) {
        const value = tiers[tier]
        if (!value) continue
        for (const field of ["model", "variant"] as const) {
            record(["tiers", tier, field], Object.hasOwn(value, field) ? "replace" : "clear", origins[provider]?.[tier]?.[field], cause)
        }
    }
}

export async function loadAutocodeConfig(
    worktree: string,
    directory: string,
    fs: ConfigFileSystem = defaultFs,
): Promise<AutocodeConfig> {
    const result = await resolveAutocodeConfig(worktree, directory, fs)
    return result.config as AutocodeConfig
}

export async function loadAutocodeConfigDetails(context: AutocodeConfigContext): Promise<AutocodeConfigDetails> {
    const coordinates = configCoordinates(context)
    return resolveAutocodeConfig(coordinates?.[0], coordinates?.[1], defaultFs, true)
}

async function resolveAutocodeConfig(
    worktree: string | undefined,
    directory: string | undefined,
    fs: ConfigFileSystem,
    detailed: boolean = false,
): Promise<AutocodeConfigDetails> {
    const globalConfigDirectory = resolveOpenCodePaths().globalConfigRoot
    const globalConfigPath = join(globalConfigDirectory, "autocode.jsonc")
    const groups = configCandidateGroups(worktree, directory)
    const candidates: AutocodeConfigCandidateDetail[] = []
    const trace: AutocodeConfigTraceEvent[] = []
    const tierSources: AutocodeTierSource[] = []
    let failure: AutocodeConfigDetails["failure"]

    // global defaults
    const globalExisted = existsSync(globalConfigPath)
    if (!detailed) {
        fs.ensureFileSync(globalConfigPath, DEFAULT_AUTOCODE_CONFIG)
    }

    let tiers: Partial<Record<ModelTier, TierConfig>> = {}
    let providerTiers: Record<string, Partial<Record<ModelTier, TierConfig>>> = {}
    let selectedProvider: string | undefined
    let selectedProviderOrigin: AutocodeConfigOrigin | undefined
    let externalDirectories: ExternalDirectoryRules = {}
    const externalDirectoryPermissions: PermissionRule[] = []
    let sandbox: AutocodeSandboxConfig = {}
    let skills: SkillsConfig | undefined
    let memory: AutocodeMemoryConfig = { directory: DEFAULT_MEMORY_DIRECTORY }
    let credentials: CredentialPolicy = { provider: DEFAULT_CREDENTIAL_PROVIDER }
    const providerOrigins: ProviderOrigins = Object.create(null) as ProviderOrigins
    const origin = (file: string, ...path: (string | number)[]): AutocodeConfigOrigin => ({ file: resolve(file), path })
    let synthetic = false
    const record: TraceRecorder = (target, action, source, cause, permission): void => {
        if (detailed && !synthetic) trace.push({ target, action, ...(source ? { origin: source } : {}), ...(cause ? { cause } : {}), ...(permission ? { permission } : {}) })
    }
    for (const group of groups) {
        synthetic = false
        let config: { path: string; raw: string } | undefined
        let bytes: Buffer | undefined
        if (detailed && group.editable) {
            try {
                bytes = readFileSync(group.paths[0])
                config = { path: group.paths[0], raw: bytes.toString("utf8") }
            } catch (error) {
                const missing = isRecord(error) && error.code === "ENOENT"
                candidates.push({ ...group.editable, state: missing ? "missing" : "unreadable" })
                if (missing && !globalExisted && group.editable.path === resolve(globalConfigPath)) {
                    config = { path: group.paths[0], raw: DEFAULT_AUTOCODE_CONFIG }
                    synthetic = true
                }
            }
        } else {
            config = readFirstConfig(fs, group.paths)
        }
        if (!config) continue
        let document: unknown
        let documentParsed = false
        let parsed: ParsedAutocodeConfig
        try {
            if (detailed) {
                document = JSON.parse(stripJsoncComments(config.raw))
                documentParsed = true
            }
            parsed = parseAutocodeConfig(config.raw, config.path, config.path === globalConfigPath, detailed)
            if (detailed && group.editable && !synthetic) candidates.push({ ...group.editable, state: "valid", bytes: bytes as Buffer, raw: config.raw, document })
        } catch (error) {
            if (!detailed) throw error
            if (group.editable && !synthetic) candidates.push({ ...group.editable, state: "invalid", bytes: bytes as Buffer, raw: config.raw, ...(documentParsed ? { document } : {}) })
            failure ??= { kind: "invalid", file: resolve(config.path) }
            continue
        }
        if (failure) continue
        // Provider definitions merge field-wise; selecting one replaces each defined tier.
        const doc = isRecord(document) ? document : undefined
        const ac = isRecord(doc?.autocode) ? doc.autocode : undefined
        if (detailed && !synthetic && ac && ["tier", "tiers", "model", "variant"].some((key) => Object.hasOwn(ac, key))) {
            tierSources.push({
                file: resolve(config.path),
                ...(Object.hasOwn(ac, "tier") ? { tier: ac.tier } : {}),
                ...(Object.hasOwn(ac, "tiers") ? { tiers: ac.tiers } : {}),
                ...(Object.hasOwn(ac, "model") ? { model: ac.model } : {}),
                ...(Object.hasOwn(ac, "variant") ? { variant: ac.variant } : {}),
            })
        }
        if (parsed.credentials) {
            credentials = parsed.credentials
            if (isRecord(doc?.credentials) && Object.hasOwn(doc.credentials, "provider")) {
                record(["credentials", "provider"], "set", origin(config.path, "credentials", "provider"))
            } else if (detailed) {
                record(["credentials", "provider"], "clear", undefined, origin(config.path, "credentials"))
            }
        }
        if (parsed.tiers) {
            const directTiers = collectTiers(parsed.tiers) ?? {}
            providerTiers = mergeProviderTiers(providerTiers, parsed.tiers)
            if (detailed && !synthetic) {
                for (const [provider, value] of Object.entries(parsed.tiers)) {
                    const providerTier = collectTiers(value)
                    if (!providerTier) continue
                    const providerOrigin = providerOrigins[provider] ??= {}
                    for (const tier of MODEL_TIERS) {
                        const entry = providerTier[tier]
                        if (!entry) continue
                        const tierOrigin = providerOrigin[tier] ??= {}
                        for (const field of ["model", "variant"] as const) {
                            if (Object.hasOwn(entry, field)) {
                                tierOrigin[field] = origin(config.path, "autocode", "tiers", provider, tier, field)
                                record(["providers", provider, tier, field], "set", tierOrigin[field])
                            }
                        }
                    }
                }
            }

            if (parsed.tier) {
                const selectedTiers = providerTiers[parsed.tier]
                if (selectedTiers) {
                    selectedProvider = parsed.tier
                    if (detailed) selectedProviderOrigin = origin(config.path, "autocode", "tier")
                    tiers = { ...tiers, ...selectedTiers }
                    record(["selectedProvider"], "set", origin(config.path, "autocode", "tier"))
                    if (detailed) traceSelectedTiers(parsed.tier, selectedTiers, providerOrigins, origin(config.path, "autocode", "tier"), record)
                } else {
                    tiers = mergeTiers(tiers, directTiers)
                    if (detailed) traceDirectTiers(directTiers, config.path, record)
                }
            } else {
                tiers = mergeTiers(tiers, directTiers)
                if (detailed) traceDirectTiers(directTiers, config.path, record)
                if (selectedProvider && collectTiers(parsed.tiers[selectedProvider])) {
                    tiers = { ...tiers, ...providerTiers[selectedProvider] }
                    if (detailed) traceSelectedTiers(selectedProvider, providerTiers[selectedProvider], providerOrigins, origin(config.path, "autocode", "tiers", selectedProvider), record)
                }
            }
        } else if (parsed.tier) {
            const selectedTiers = providerTiers[parsed.tier]
            if (selectedTiers) {
                selectedProvider = parsed.tier
                if (detailed) selectedProviderOrigin = origin(config.path, "autocode", "tier")
                tiers = { ...tiers, ...selectedTiers }
                record(["selectedProvider"], "set", origin(config.path, "autocode", "tier"))
                if (detailed) traceSelectedTiers(parsed.tier, selectedTiers, providerOrigins, origin(config.path, "autocode", "tier"), record)
            }
        }
        if (typeof ac?.tier === "string") record(["tier"], parsed.tier && providerTiers[parsed.tier] ? "set" : "ignored", origin(config.path, "autocode", "tier"))
        if (parsed.externalDirectories) {
            externalDirectories = mergeExternalDirectoryRules(externalDirectories, parsed.externalDirectories)
        }
        externalDirectoryPermissions.push(...parsed.externalDirectoryPermissions ?? [])
        if (Array.isArray(doc?.permissions)) {
            const lastIndices = new Map<string, number>()
            doc.permissions.forEach((rule: unknown, index: number) => {
                if (collectExternalDirectoryPermissions([rule]).length === 0 || !isRecord(rule)) return
                lastIndices.set(rule.resource as string, index)
                record(["externalDirectoryPermissions"], "append", origin(config.path, "permissions", index), undefined, { resource: rule.resource as string, effect: rule.effect as PermissionAction })
            })
            for (const [pattern, effect] of Object.entries(parsed.externalDirectories ?? {})) {
                record(["externalDirectories", pattern], "replace", origin(config.path, "permissions", lastIndices.get(pattern) as number, "effect"), undefined, { resource: pattern, effect })
            }
        }
        if (parsed.sandbox) {
            sandbox = { ...sandbox, ...parsed.sandbox }
            for (const key of Object.keys(parsed.sandbox)) {
                const path = key === "sync_method" ? ["sync_method"] : ["distro", key === "distro_cache_path" ? "cache_path" : "expire"]
                record(["sandbox", key], "set", origin(config.path, "autocode", "sandbox", ...path))
            }
        }
        if (parsed.skills) {
            skills = { ...(skills ?? {}), ...parsed.skills }
            record(["skills", "freeze"], "set", origin(config.path, "autocode", "skills", "freeze"))
        }
        if (parsed.memory) {
            memory = { ...memory, ...parsed.memory }
            record(["memory", "directory"], "set", origin(config.path, "autocode", "memory", "directory"))
        }
        if (parsed.legacyTiers) {
            tiers = mergeTiers(tiers, parsed.legacyTiers)
            for (const tier of MODEL_TIERS) {
                if (!parsed.legacyTiers[tier]) {
                    if (isRecord(ac?.variant) && Object.hasOwn(ac.variant, tier)) record(["tiers", tier, "variant"], "ignored", origin(config.path, "autocode", "variant", tier))
                    continue
                }
                record(["tiers", tier, "model"], "set", origin(config.path, "autocode", "model", tier))
                const hasVariant = isRecord(ac?.variant) && Object.hasOwn(ac.variant, tier)
                record(["tiers", tier, "variant"], hasVariant ? "set" : "clear", hasVariant ? origin(config.path, "autocode", "variant", tier) : undefined, origin(config.path, "autocode", "model", tier))
            }
        } else if (ac) {
            for (const field of ["model", "variant"] as const) {
                if (!isRecord(ac[field])) continue
                for (const tier of MODEL_TIERS) {
                    if (Object.hasOwn(ac[field], tier)) record(["tiers", tier, field], "ignored", origin(config.path, "autocode", field, tier))
                }
            }
        }
    }

    // Idempotent skill seeding: ONLY creates the `autocode.skills` key when ALL of the
    // following are true:
    //   - global config file already existed before this load
    //   - parsed root is a record
    //   - `autocode` section is itself a record (never an array / primitive)
    //   - `skills` key is entirely absent from `autocode`
    // Any other section (tiers, sandbox, ...) is NEVER touched.
    // If `skills` already exists with any value (including null / arrays / scalars),
    // it is left alone. If `autocode` is not a record, seeding is skipped entirely
    // so the user's custom configuration can never be replaced.
    synthetic = false
    if (detailed && globalExisted && !failure) {
        const globalCandidate = candidates[0]
        if (globalCandidate?.state === "valid" && isRecord(globalCandidate.document)
            && isRecord(globalCandidate.document.autocode) && !("skills" in globalCandidate.document.autocode)) {
            const seeded = collectSkills(DEFAULT_SKILLS, true)
            if (seeded) {
                skills = { ...(skills ?? {}), ...seeded }
                record(["skills", "freeze"], "set", undefined, origin(globalConfigPath, "autocode", "skills"))
            }
        }
    } else if (!detailed && globalExisted && !failure) {
        try {
            const raw = fs.readFileSync(globalConfigPath, "utf-8")
            const parsed = JSON.parse(stripJsoncComments(raw)) as { autocode?: Record<string, unknown> }
            const ac = parsed.autocode
            if (isRecord(parsed) && isRecord(ac) && !("skills" in ac)) {
                const defaultSkills = DEFAULT_SKILLS
                const editor = createJsoncDocumentEditor(raw)
                editor.apply({ kind: "create", path: ["autocode", "skills"], value: defaultSkills, index: null })
                const updated = editor.toString()
                fs.writeFileSync(globalConfigPath, updated)
                const seeded = collectSkills(defaultSkills)
                if (seeded) {
                    skills = { ...(skills ?? {}), ...seeded }
                    record(["skills", "freeze"], "set", origin(globalConfigPath, "autocode", "skills", "freeze"))
                }
            }
        } catch (err) {
            console.error(`autocode: failed to seed default skills: ${(err as Error).message}`)
        }
    }

    return {
        ...(failure ? { failure } : {
            config: { tiers, externalDirectories, externalDirectoryPermissions, sandbox, skills, memory, credentials },
            ...(detailed ? { tierResolution: { selectedProvider, selectedProviderOrigin, providerTiers } } : {}),
        }),
        candidates,
        trace,
        tierSources,
    }
}
