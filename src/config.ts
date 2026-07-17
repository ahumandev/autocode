import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "path"

import defaultAutocodeConfig from "./default-autocode.jsonc" with { type: "json" }

const MODEL_TIERS = ["cheap", "fast", "balanced", "smart"] as const
const PERMISSION_ACTIONS = ["ask", "allow", "deny"] as const
const SANDBOX_SYNC_METHODS = ["auto", "overlayfs", "reflink", "copy"] as const
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

export type SkillCategory = "bash" | "code" | "design" | "test"
export type SkillsConfig = Partial<Record<SkillCategory, string[]>>

export interface ConfigFileSystem {
    readFileSync(path: string, encoding: "utf-8"): string
    ensureFileSync(path: string, contents: string): void
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
}

const DEFAULT_AUTOCODE_CONFIG = JSON.stringify(defaultAutocodeConfig, null, 4) + "\n"

type AutocodeJsoncNew = {
    autocode?: {
        tier?: unknown
        tiers?: Record<string, unknown>
        sandbox?: unknown
        skills?: unknown
    }
    permission?: {
        external_directory?: unknown
    }
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
    sandbox?: AutocodeSandboxConfig
    skills?: SkillsConfig
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
    if (typeof value === "string" && PERMISSION_ACTIONS.includes(value as PermissionAction)) {
        return { "*": value as PermissionAction }
    }

    if (!isRecord(value)) return undefined

    const result: ExternalDirectoryRules = {}

    for (const [pattern, action] of Object.entries(value)) {
        if (typeof action !== "string" || !PERMISSION_ACTIONS.includes(action as PermissionAction)) {
            continue
        }

        result[pattern] = action as PermissionAction
    }

    return Object.keys(result).length > 0 ? result : undefined
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

function collectSkills(value: unknown): SkillsConfig | undefined {
    if (value === undefined) return undefined
    if (!isRecord(value)) {
        console.warn(`autocode: invalid skills config (expected object, got ${Array.isArray(value) ? "array" : typeof value})`)
        return undefined
    }
    const known = new Set<string>(SKILL_CATEGORIES)
    const result: SkillsConfig = {}
    let hasAny = false
    for (const key of Object.keys(value)) {
        if (!known.has(key)) {
            console.warn(`autocode: ignoring unknown skills category "${key}"`)
            continue
        }
        const list = value[key]
        if (!Array.isArray(list)) continue
        result[key as SkillCategory] = list as string[]
        hasAny = true
    }
    return hasAny ? result : undefined
}

function mergeTierMaps(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...base }

    for (const [key, value] of Object.entries(next)) {
        if (MODEL_TIERS.includes(key as ModelTier) || !isRecord(merged[key]) || !isRecord(value)) {
            merged[key] = value
            continue
        }

        merged[key] = { ...(merged[key] as Record<string, unknown>), ...value }
    }

    return merged
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

function parseAutocodeConfig(raw: string, path: string): ParsedAutocodeConfig {
    let parsed: AutocodeJsoncNew & AutocodeJsoncLegacy
    try {
        parsed = JSON.parse(stripJsoncComments(raw))
    } catch (err) {
        throw new Error(`autocode: malformed JSONC in ${path}: ${(err as Error).message}`)
    }
    const ac = parsed?.autocode
    const externalDirectories = collectExternalDirectories(parsed.permission?.external_directory)
    const sandbox = collectSandboxConfig(ac?.sandbox)
    const skills = collectSkills(ac?.skills)

    if (!ac) return { externalDirectories, sandbox, skills }

    if (isRecord(ac.tiers)) {
        return {
            tier: typeof ac.tier === "string" ? ac.tier : undefined,
            tiers: ac.tiers,
            externalDirectories,
            sandbox,
            skills,
        }
    }

    if (typeof ac.tier === "string") {
        return { tier: ac.tier, externalDirectories, sandbox, skills }
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
        return { legacyTiers: result, externalDirectories, sandbox, skills }
    }

    return { externalDirectories, sandbox, skills }
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

function resolveTiers(config: ParsedAutocodeConfig, availableTiers: Record<string, unknown>): Partial<Record<ModelTier, TierConfig>> {
    if (config.legacyTiers) return config.legacyTiers

    if (config.tier) {
        const selectedTiers = collectTiers(availableTiers[config.tier])
        if (selectedTiers) return selectedTiers
    }

    return collectTiers(availableTiers) ?? {}
}

export async function loadAutocodeConfig(
    worktree: string,
    directory: string,
    fs: ConfigFileSystem = defaultFs,
): Promise<{ tiers: Partial<Record<ModelTier, TierConfig>>, externalDirectories: ExternalDirectoryRules, sandbox: AutocodeSandboxConfig, skills: SkillsConfig | undefined }> {
    const globalConfigPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "autocode.jsonc")
    const candidates: string[] = []

    // global defaults
    const globalExisted = existsSync(globalConfigPath)
    fs.ensureFileSync(globalConfigPath, DEFAULT_AUTOCODE_CONFIG)
    addCandidate(candidates, globalConfigPath)

    for (const candidate of collectLocalConfigCandidates(worktree, directory)) {
        addCandidate(candidates, candidate)
    }

    let tiers: Partial<Record<ModelTier, TierConfig>> = {}
    let availableTiers: Record<string, unknown> = {}
    let externalDirectories: ExternalDirectoryRules = {}
    let sandbox: AutocodeSandboxConfig = {}
    let skills: SkillsConfig | undefined
    for (const path of candidates) {
        let raw: string
        try {
            raw = fs.readFileSync(path, "utf-8")
        } catch {
            continue
        }
        // later candidates override earlier ones per tier
        const parsed = parseAutocodeConfig(raw, path)
        if (parsed.tiers) {
            availableTiers = mergeTierMaps(availableTiers, parsed.tiers)
        }
        if (parsed.externalDirectories) {
            externalDirectories = mergeExternalDirectoryRules(externalDirectories, parsed.externalDirectories)
        }
        if (parsed.sandbox) {
            sandbox = { ...sandbox, ...parsed.sandbox }
        }
        if (parsed.skills) {
            skills = { ...(skills ?? {}), ...parsed.skills }
        }
        tiers = { ...tiers, ...resolveTiers(parsed, availableTiers) }
    }

    // Idempotent skill seeding: when global config exists but `autocode.skills` key is
    // entirely absent, inject the default skills block. Missing file is already handled
    // by ensureFileSync + the candidate loop above.
    if (globalExisted) {
        try {
            const raw = fs.readFileSync(globalConfigPath, "utf-8")
            const parsed = JSON.parse(stripJsoncComments(raw)) as { autocode?: Record<string, unknown> }
            const ac = parsed.autocode
            if (isRecord(parsed) && ac && !("skills" in ac)) {
                const defaultSkills = JSON.parse(stripJsoncComments(DEFAULT_AUTOCODE_CONFIG)).autocode?.skills
                if (!isRecord(ac)) {
                    parsed.autocode = { skills: defaultSkills }
                } else {
                    ac.skills = defaultSkills
                }
                writeFileSync(globalConfigPath, JSON.stringify(parsed, null, 4))
                const seeded = collectSkills(ac.skills)
                if (seeded) skills = { ...(skills ?? {}), ...seeded }
            }
        } catch (err) {
            console.error(`autocode: failed to seed default skills: ${(err as Error).message}`)
        }
    }

    return { tiers, externalDirectories, sandbox, skills }
}
