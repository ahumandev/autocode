import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import defaultAutocodeConfig from "./default-autocode.jsonc" with { type: "json" }
import { createJsoncDocumentEditor } from "./tools/config/json"

const MODEL_TIERS = ["cheap", "fast", "operator", "balanced", "smart"] as const
const PERMISSION_ACTIONS = ["ask", "allow", "deny"] as const
const SANDBOX_SYNC_METHODS = ["auto", "overlayfs", "reflink", "copy"] as const
const SKILL_CATEGORIES: readonly SkillCategory[] = ["bash", "code", "design", "test"]

export type ModelTier = (typeof MODEL_TIERS)[number]
export type TierConfig = { model?: string; variant?: string }
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]
export type ExternalDirectoryRules = Record<string, PermissionAction>
export type TaskExternalRules = ExternalDirectoryRules
export type SandboxSyncMethod = (typeof SANDBOX_SYNC_METHODS)[number]
export type AutocodeSandboxConfig = {
    sync_method?: SandboxSyncMethod
    distro_cache_path?: string
    distro_expire?: string | number
}

export type SkillCategory = "bash" | "code" | "design" | "test"
export type SkillsConfig = Partial<Record<SkillCategory, string[]>> & { freeze?: boolean }

export type LearnedConfig = { max?: number }
const DEFAULT_LEARNED_MAX = 10

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

const DEFAULT_AUTOCODE_CONFIG =
    JSON.stringify(
        {
            ...defaultAutocodeConfig,
            autocode: {
                ...defaultAutocodeConfig.autocode,
                learned: { max: DEFAULT_LEARNED_MAX },
            },
        },
        null,
        4,
    ) + "\n"

type AutocodeJsoncNew = {
    autocode?: {
        tier?: unknown
        tiers?: Record<string, unknown>
        sandbox?: unknown
        skills?: unknown
        learned?: unknown
    }
    permission?: {
        external_directory?: unknown
        task_external?: unknown
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
    taskExternalRules?: TaskExternalRules
    sandbox?: AutocodeSandboxConfig
    skills?: SkillsConfig
    learned?: LearnedConfig
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

export function collectTaskExternalRules(value: unknown): TaskExternalRules | undefined {
    return collectExternalDirectories(value)
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
    const result: SkillsConfig = {}
    if ("freeze" in value) {
        if (typeof value.freeze !== "boolean") {
            console.warn(`autocode: invalid skills.freeze (expected boolean, got ${JSON.stringify(value.freeze)}); falling back to false`)
            result.freeze = false
        } else {
            result.freeze = value.freeze
        }
    }

    if (SKILL_CATEGORIES.some((category) => Array.isArray(value[category]))) {
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

function collectLearned(value: unknown): LearnedConfig | undefined {
    if (value === undefined) return undefined
    if (!isRecord(value)) {
        console.warn(`autocode: invalid learned config (expected object, got ${Array.isArray(value) ? "array" : typeof value})`)
        return undefined
    }
    const result: LearnedConfig = {}
    if ("max" in value) {
        const max = value.max
        if (typeof max !== "number" || !Number.isFinite(max) || !Number.isInteger(max) || max <= 0) {
            console.warn(
                `autocode: invalid learned.max (expected positive integer, got ${JSON.stringify(max)}); falling back to ${DEFAULT_LEARNED_MAX}`,
            )
            result.max = DEFAULT_LEARNED_MAX
        } else {
            result.max = max
        }
    }
    return Object.keys(result).length > 0 ? result : undefined
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
    const taskExternalRules = collectTaskExternalRules(parsed.permission?.task_external)
    const sandbox = collectSandboxConfig(ac?.sandbox)
    const skills = collectSkills(ac?.skills)
    const learned = collectLearned(ac?.learned)

    if (!ac) return { externalDirectories, taskExternalRules, sandbox, skills, learned }

    if (isRecord(ac.tiers)) {
        return {
            tier: typeof ac.tier === "string" ? ac.tier : undefined,
            tiers: ac.tiers,
            externalDirectories,
            taskExternalRules,
            sandbox,
            skills,
            learned,
        }
    }

    if (typeof ac.tier === "string") {
        return { tier: ac.tier, externalDirectories, taskExternalRules, sandbox, skills, learned }
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
        return { legacyTiers: result, externalDirectories, taskExternalRules, sandbox, skills, learned }
    }

    return { externalDirectories, taskExternalRules, sandbox, skills, learned }
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

function readFirstConfig(fs: ConfigFileSystem, paths: readonly string[]): { path: string, raw: string } | undefined {
    for (const path of paths) {
        try {
            return { path, raw: fs.readFileSync(path, "utf-8") }
        } catch {
        }
    }
    return undefined
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
): Promise<{ tiers: Partial<Record<ModelTier, TierConfig>>, externalDirectories: ExternalDirectoryRules, sandbox: AutocodeSandboxConfig, skills: SkillsConfig | undefined, learned: LearnedConfig }> {
    const globalConfigDirectory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
    const globalConfigPath = join(globalConfigDirectory, "autocode.jsonc")
    const candidates: string[][] = []

    // global defaults
    const globalExisted = existsSync(globalConfigPath)
    fs.ensureFileSync(globalConfigPath, DEFAULT_AUTOCODE_CONFIG)
    candidates.push([join(globalConfigDirectory, "opencode.jsonc"), join(globalConfigDirectory, "opencode.json")])
    candidates.push([globalConfigPath])

    candidates.push(...collectLocalOpencodeConfigCandidates(worktree, directory))
    candidates.push(...collectLocalConfigCandidates(worktree, directory).map((path) => [path]))

    let tiers: Partial<Record<ModelTier, TierConfig>> = {}
    let availableTiers: Record<string, unknown> = {}
    let externalDirectories: ExternalDirectoryRules = {}
    let sandbox: AutocodeSandboxConfig = {}
    let skills: SkillsConfig | undefined
    let learned: LearnedConfig = { max: DEFAULT_LEARNED_MAX }
    for (const candidate of candidates) {
        const config = readFirstConfig(fs, candidate)
        if (!config) continue
        // later candidates override earlier ones per tier
        const parsed = parseAutocodeConfig(config.raw, config.path)
        if (parsed.tiers) {
            availableTiers = mergeTierMaps(availableTiers, parsed.tiers)
        }
        if (parsed.externalDirectories) {
            externalDirectories = mergeExternalDirectoryRules(externalDirectories, parsed.externalDirectories)
        }
        if (parsed.taskExternalRules) {
            externalDirectories = mergeExternalDirectoryRules(externalDirectories, parsed.taskExternalRules)
        }
        if (parsed.sandbox) {
            sandbox = { ...sandbox, ...parsed.sandbox }
        }
        if (parsed.skills) {
            skills = { ...(skills ?? {}), ...parsed.skills }
        }
        if (parsed.learned) {
            learned = { ...learned, ...parsed.learned }
        }
        tiers = { ...tiers, ...resolveTiers(parsed, availableTiers) }
    }

    // Idempotent skill seeding: ONLY creates the `autocode.skills` key when ALL of the
    // following are true:
    //   - global config file already existed before this load
    //   - parsed root is a record
    //   - `autocode` section is itself a record (never an array / primitive)
    //   - `skills` key is entirely absent from `autocode`
    // Any other section (tiers, sandbox, learned, ...) is NEVER touched.
    // If `skills` already exists with any value (including null / arrays / scalars),
    // it is left alone. If `autocode` is not a record, seeding is skipped entirely
    // so the user's custom configuration can never be replaced.
    if (globalExisted) {
        try {
            const raw = fs.readFileSync(globalConfigPath, "utf-8")
            const parsed = JSON.parse(stripJsoncComments(raw)) as { autocode?: Record<string, unknown> }
            const ac = parsed.autocode
            if (isRecord(parsed) && isRecord(ac) && !("skills" in ac)) {
                const defaultSkills: SkillsConfig = defaultAutocodeConfig.autocode.skills
                const editor = createJsoncDocumentEditor(raw)
                editor.apply({ kind: "create", path: ["autocode", "skills"], value: defaultSkills, index: null })
                fs.writeFileSync(globalConfigPath, editor.toString())
                const seeded = collectSkills(defaultSkills)
                if (seeded) skills = { ...(skills ?? {}), ...seeded }
            }
        } catch (err) {
            console.error(`autocode: failed to seed default skills: ${(err as Error).message}`)
        }
    }

    return { tiers, externalDirectories, sandbox, skills, learned }
}
