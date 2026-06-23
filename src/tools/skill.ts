import type { OpencodeClient } from "@opencode-ai/sdk"
import { tool } from "@opencode-ai/plugin"
import { createHash } from "crypto"
import { readFile, readdir } from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { getGeneratedSkillsRoot } from "@/skills"
import { isMissingFile, resolveAgentsStorageRoot } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse, flattenError } from "@/utils/tools"

type FileSystem = {
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    readdir: (filePath: string, options: { withFileTypes: true }) => Promise<Array<{ isDirectory: () => boolean, isFile: () => boolean, name: string }>>
}

type SkillLoadArgs = {
    name?: unknown
}

type SkillLoadContext = {
    directory: string
    sessionID?: string
    worktree: string
}

type LoadedSkill = {
    content: string
    directory: string
    location: string
    name: string
}

type ActiveContextInfo = {
    checked: boolean
    available: boolean
    method: string | null
    reason: string | null
    response_scan: ActiveContextResponseScan | null
    probe_errors: string[]
    client_top_level_keys?: string[]
    probe_names?: string[]
}

type ActiveContextResult = {
    found: boolean
    info: ActiveContextInfo
}

type ActiveContextResponseScan = {
    top_level_keys: string[]
    data_array: boolean
    data_length: number | null
}

type LiveCacheDiagnostics = {
    checked: boolean
    hit: boolean
    stored: boolean
    reason: string | null
    size: number
}

type OptionalActiveContextClient = {
    _client?: {
        getConfig?: () => ClientFetchConfig
        request?: (options: { method?: string, parseAs?: string, url: string, query?: Record<string, string> }) => Promise<unknown>
    }
    v2?: {
        session?: {
            context?: (args: V2ContextRequest) => Promise<unknown>
        }
    }
    session?: {
        activeContext?: (args: ActiveContextRequest) => Promise<unknown>
        context?: (args: ActiveContextRequest) => Promise<unknown>
    }
    experimental?: {
        context?: {
            get?: (args: ExperimentalContextRequest) => Promise<unknown>
        }
    }
}

type ActiveContextRequest = {
    path: { id: string }
    query: { directory: string }
}

type V2ContextRequest = {
    sessionID: string
}

type ExperimentalContextRequest = {
    directory: string
    sessionID: string
}

type LoadResult = {
    name: string
    directory: string
    output?: string
}

type SkillLoadRuntime = {
    serverUrl?: string | URL
}

type ClientFetchConfig = {
    baseUrl?: string
    fetch?: (request: Request) => Promise<Response>
    headers?: HeadersInit
}

const defaultFileSystem: FileSystem = { readFile, readdir }
const safeIdentityPrefix = "skill"
const FILE_LIMIT = 10
const LIVE_DEDUPE_CACHE_TTL_MS = 30 * 60 * 1000
const LIVE_DEDUPE_CACHE_MAX_ENTRIES = 256
const liveDedupeCache = new Map<string, { expiresAt: number, lastAccessed: number }>()

function buildLiveDedupeCacheKey(sessionID: string, identity: string, hash: string): string {
    return `${sessionID}\0${identity}\0${hash}`
}

function pruneLiveDedupeCache(now = Date.now()): void {
    for (const [key, entry] of liveDedupeCache) {
        if (entry.expiresAt <= now) {
            liveDedupeCache.delete(key)
        }
    }

    while (liveDedupeCache.size > LIVE_DEDUPE_CACHE_MAX_ENTRIES) {
        let oldestKey: string | undefined
        let oldestAccess = Number.POSITIVE_INFINITY
        for (const [key, entry] of liveDedupeCache) {
            if (entry.lastAccessed < oldestAccess) {
                oldestAccess = entry.lastAccessed
                oldestKey = key
            }
        }

        if (oldestKey === undefined) {
            return
        }

        liveDedupeCache.delete(oldestKey)
    }
}

function checkLiveDedupeCache(context: SkillLoadContext, identity: string, hash: string): LiveCacheDiagnostics {
    if (!context.sessionID) {
        return { checked: false, hit: false, stored: false, reason: "missing sessionID", size: liveDedupeCache.size }
    }

    const now = Date.now()
    pruneLiveDedupeCache(now)
    const entry = liveDedupeCache.get(buildLiveDedupeCacheKey(context.sessionID, identity, hash))
    if (entry === undefined) {
        return { checked: true, hit: false, stored: false, reason: null, size: liveDedupeCache.size }
    }

    entry.lastAccessed = now
    entry.expiresAt = now + LIVE_DEDUPE_CACHE_TTL_MS
    return { checked: true, hit: true, stored: false, reason: "live cache hit", size: liveDedupeCache.size }
}

function storeLiveDedupeCache(context: SkillLoadContext, identity: string, hash: string, cache: LiveCacheDiagnostics): LiveCacheDiagnostics {
    if (!context.sessionID) {
        return { ...cache, stored: false, reason: "missing sessionID", size: liveDedupeCache.size }
    }

    const now = Date.now()
    liveDedupeCache.set(buildLiveDedupeCacheKey(context.sessionID, identity, hash), { expiresAt: now + LIVE_DEDUPE_CACHE_TTL_MS, lastAccessed: now })
    pruneLiveDedupeCache(now)
    return { ...cache, stored: true, size: liveDedupeCache.size }
}

export function clearAutocodeSkillLoadLiveCacheForTest(): void {
    liveDedupeCache.clear()
}

function buildSkillNotFoundError(name: string): string {
    return `Unable to load skill ${name}`
}

function validateSkillLoadArgs(args: SkillLoadArgs): { name: string } | { error: string, instruction: string } {
    const unexpectedArgs = Object.keys(args).filter((key) => key !== "name")
    if (unexpectedArgs.length > 0) {
        return {
            error: `Unexpected argument(s): ${unexpectedArgs.join(", ")}.`,
            instruction: "Retry with exactly the name argument.",
        }
    }

    if (typeof args.name !== "string" || !args.name.trim()) {
        return {
            error: "Invalid name. Name must be a non-empty string.",
            instruction: "Retry with a skill name from the available skills list.",
        }
    }

    return { name: args.name.trim() }
}

function parseSkillMarkdown(filePath: string, source: string, inferredName?: string): LoadedSkill | undefined {
    const normalizedSource = source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n")
    const match = normalizedSource.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    if (!match) {
        return undefined
    }

    const frontmatter = match[1]
    const content = match[2]
    const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? (path.basename(filePath) === "SKILL.md" ? inferredName : path.basename(filePath, ".md"))
    if (!name) {
        return undefined
    }

    return {
        content,
        directory: path.dirname(filePath),
        location: filePath,
        name,
    }
}

async function collectSkillFiles(fileSystem: FileSystem, root: string): Promise<string[]> {
    async function walk(directory: string): Promise<string[]> {
        let entries: Awaited<ReturnType<FileSystem["readdir"]>>
        try {
            entries = await fileSystem.readdir(directory, { withFileTypes: true })
        }
        catch (error) {
            if (isMissingFile(error)) {
                return []
            }

            throw error
        }

        const files: string[] = []
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                files.push(...await walk(entryPath))
            }
            else if (entry.isFile() && (entry.name === "SKILL.md" || (directory === root && entry.name.endsWith(".md")))) {
                files.push(entryPath)
            }
        }

        return files
    }

    return (await walk(root)).sort()
}

function inferNestedSkillName(root: string, filePath: string): string | undefined {
    if (path.basename(filePath) !== "SKILL.md") {
        return undefined
    }

    const relativeDirectory = path.relative(root, path.dirname(filePath))
    if (!relativeDirectory || relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) {
        return undefined
    }

    return relativeDirectory.split(path.sep).join("/")
}

async function loadSkillsFromRoot(fileSystem: FileSystem, root: string, inferNestedNames = false): Promise<LoadedSkill[]> {
    const skills: LoadedSkill[] = []
    for (const filePath of await collectSkillFiles(fileSystem, root)) {
        const source = await fileSystem.readFile(filePath, "utf8").catch((error: unknown) => {
            if (isMissingFile(error)) {
                return undefined
            }

            throw error
        })
        if (source === undefined) {
            continue
        }

        const skill = parseSkillMarkdown(filePath, source, inferNestedNames ? inferNestedSkillName(root, filePath) : undefined)
        if (skill !== undefined) {
            skills.push(skill)
        }
    }

    return skills
}

async function loadSkill(fileSystem: FileSystem, context: SkillLoadContext, name: string): Promise<LoadedSkill | undefined> {
    const roots = [
        { path: path.resolve(getGeneratedSkillsRoot()), inferNestedNames: false },
        { path: path.resolve(resolveAgentsStorageRoot(context), ".agents", "skills"), inferNestedNames: true },
        { path: path.resolve(resolveAgentsStorageRoot(context), ".opencode", "skills"), inferNestedNames: false },
    ]
    for (const root of roots) {
        const skill = (await loadSkillsFromRoot(fileSystem, root.path, root.inferNestedNames)).find((candidate) => candidate.name === name)
        if (skill !== undefined) {
            return skill
        }
    }

    return undefined
}

export function buildAutocodeSkillLoadIdentity(name: string): string {
    return `${safeIdentityPrefix}:${encodeURIComponent(name)}`
}

export function buildAutocodeSkillLoadHash(identity: string, skill: { content: string, location?: string }): string {
    return createHash("sha256").update(JSON.stringify({ identity, content: skill.content })).digest("hex")
}

export function buildAutocodeSkillLoadMarker(identity: string, hash: string): string {
    return `<!-- ${safeIdentityPrefix} identity=${identity} hash=${hash} -->`
}

export function activeContextIncludesMarkerHash(value: unknown, marker: string, hash: string): boolean {
    const seen = new WeakSet<object>()

    function scan(entry: unknown): boolean {
        if (typeof entry === "string") {
            return entry.includes(marker) && entry.includes(hash)
        }

        if (Array.isArray(entry)) {
            return entry.some(scan)
        }

        if (typeof entry === "object" && entry !== null) {
            if (seen.has(entry)) {
                return false
            }

            seen.add(entry)
            return Object.values(entry as Record<string, unknown>).some(scan)
        }

        return false
    }

    return scan(value)
}

function summarizeActiveContextResponse(response: unknown): ActiveContextResponseScan {
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
        return { top_level_keys: [], data_array: false, data_length: null }
    }

    const record = response as Record<string, unknown>
    const data = record.data
    return {
        top_level_keys: Object.keys(record).sort(),
        data_array: Array.isArray(data),
        data_length: Array.isArray(data) ? data.length : null,
    }
}

function safeTopLevelKeys(value: unknown): string[] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return []
    }

    return Object.keys(value).sort()
}

function resolveActiveContextBaseUrl(client: OptionalActiveContextClient, runtime?: SkillLoadRuntime): string | undefined {
    const configBaseUrl = client._client?.getConfig?.().baseUrl
    if (typeof configBaseUrl === "string" && configBaseUrl.length > 0) {
        return configBaseUrl
    }

    const runtimeUrl = runtime?.serverUrl
    if (runtimeUrl instanceof URL) {
        return runtimeUrl.toString()
    }

    return typeof runtimeUrl === "string" && runtimeUrl.length > 0 ? runtimeUrl : undefined
}

async function fetchActiveContextDirect(client: OptionalActiveContextClient, context: SkillLoadContext, baseUrl: string): Promise<unknown> {
    const endpoint = new URL(`/api/session/${encodeURIComponent(context.sessionID ?? "")}/context`, baseUrl)
    endpoint.searchParams.set("directory", context.directory)
    const config = client._client?.getConfig?.() ?? {}
    const fetchImpl = config.fetch ?? fetch
    const response = await fetchImpl(new Request(endpoint, { headers: config.headers }))
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
    }

    const contentType = response.headers.get("content-type") ?? ""
    return contentType.includes("application/json") ? response.json() : response.text()
}

async function listSkillFiles(fileSystem: FileSystem, skill: LoadedSkill): Promise<string[]> {
    if (path.basename(skill.location) !== "SKILL.md") {
        return []
    }

    async function walk(directory: string): Promise<string[]> {
        const entries = await fileSystem.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
            if (isMissingFile(error)) {
                return []
            }

            throw error
        })
        const files: string[] = []
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                files.push(...await walk(entryPath))
            }
            else if (entry.isFile()) {
                files.push(entryPath)
            }
        }

        return files
    }

    return (await walk(skill.directory))
        .filter((file) => path.basename(file) !== "SKILL.md")
        .sort()
        .slice(0, FILE_LIMIT)
}

function renderSkillContent(marker: string, skill: LoadedSkill, files: readonly string[]): string {
    return [
        marker,
        `<skill_content name="${skill.name}">`,
        `# Skill: ${skill.name}`,
        "",
        skill.content.trim(),
        "",
        `Base directory for this skill: ${pathToFileURL(skill.directory).href}`,
        "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
        "Note: file list is sampled.",
        "",
        "<skill_files>",
        ...files.map((file) => `<file>${file}</file>`),
        "</skill_files>",
        "</skill_content>",
    ].join("\n")
}

async function readActiveContext(client: OpencodeClient | undefined, context: SkillLoadContext, marker: string, hash: string, runtime?: SkillLoadRuntime): Promise<ActiveContextResult> {
    if (client === undefined) {
        return { found: false, info: { checked: false, available: false, method: null, reason: "client unavailable", response_scan: null, probe_errors: [] } }
    }

    if (!context.sessionID) {
        return { found: false, info: { checked: false, available: false, method: null, reason: "session id unavailable", response_scan: null, probe_errors: [] } }
    }

    const activeClient = client as unknown as OptionalActiveContextClient
    const request = { path: { id: context.sessionID }, query: { directory: context.directory } }
    const v2Request = { sessionID: context.sessionID }
    const probes: Array<{ method: string, call: () => Promise<unknown> } | undefined> = [
        activeClient.v2?.session?.context === undefined ? undefined : { method: "client.v2.session.context", call: () => activeClient.v2?.session?.context?.(v2Request) ?? Promise.resolve(undefined) },
        activeClient.session?.activeContext === undefined ? undefined : { method: "client.session.activeContext", call: () => activeClient.session?.activeContext?.(request) ?? Promise.resolve(undefined) },
        activeClient.session?.context === undefined ? undefined : { method: "client.session.context", call: () => activeClient.session?.context?.(request) ?? Promise.resolve(undefined) },
        activeClient.experimental?.context?.get === undefined ? undefined : { method: "client.experimental.context.get", call: () => activeClient.experimental?.context?.get?.({ directory: context.directory, sessionID: context.sessionID ?? "" }) ?? Promise.resolve(undefined) },
    ]
    const probeNames = ["client.v2.session.context", "client.session.activeContext", "client.session.context", "client.experimental.context.get", "http.GET /api/session/{sessionID}/context"]
    const errors: string[] = []

    for (const probe of probes) {
        if (probe === undefined) {
            continue
        }

        try {
            const response = await probe.call()
            const found = activeContextIncludesMarkerHash(response, marker, hash)
            return {
                found,
                info: { checked: true, available: true, method: probe.method, reason: null, response_scan: summarizeActiveContextResponse(response), probe_errors: errors },
            }
        }
        catch (error) {
            errors.push(`${probe.method}: ${flattenError(error)}`)
        }
    }

    const baseUrl = resolveActiveContextBaseUrl(activeClient, runtime)
    if (baseUrl !== undefined) {
        const method = "http.GET /api/session/{sessionID}/context"
        try {
            const response = await fetchActiveContextDirect(activeClient, context, baseUrl)
            const found = activeContextIncludesMarkerHash(response, marker, hash)
            return {
                found,
                info: { checked: true, available: true, method, reason: null, response_scan: summarizeActiveContextResponse(response), probe_errors: errors },
            }
        }
        catch (error) {
            errors.push(`${method}: ${flattenError(error)}`)
        }
    }

    if (errors.length > 0) {
        return { found: false, info: { checked: true, available: false, method: null, reason: errors.join("; "), response_scan: null, probe_errors: errors, client_top_level_keys: safeTopLevelKeys(client), probe_names: probeNames } }
    }

    return { found: false, info: { checked: true, available: false, method: null, reason: "active context API unavailable; base URL unavailable", response_scan: null, probe_errors: [], client_top_level_keys: safeTopLevelKeys(client), probe_names: probeNames } }
}

export function createSkillTool(client?: OpencodeClient, fileSystem: FileSystem = defaultFileSystem, runtime?: SkillLoadRuntime): ReturnType<typeof tool> {
    return tool({
        description: "Load specialized skill when task matches one of available skills. Use skill tool to read skill's instructions, resources, workflow guidance and references to scripts, files, etc. in the same directory as the skill.",
        args: {
            name: tool.schema.string().describe("name of skill from available skills list"),
        },
        async execute(args, context) {
            const validatedArgs = validateSkillLoadArgs(args)
            if ("error" in validatedArgs) {
                return createRetryResponse("load skill", validatedArgs.error, validatedArgs.instruction)
            }

            const skillContext = context as SkillLoadContext
            try {
                const skill = await loadSkill(fileSystem, skillContext, validatedArgs.name)
                if (skill === undefined) {
                    return createAbortResponse("load skill", buildSkillNotFoundError(validatedArgs.name))
                }

                const identity = buildAutocodeSkillLoadIdentity(skill.name)
                const hash = buildAutocodeSkillLoadHash(identity, skill)
                const marker = buildAutocodeSkillLoadMarker(identity, hash)
                const checkedCache = checkLiveDedupeCache(skillContext, identity, hash)

                if (checkedCache.hit) {
                    return JSON.stringify({
                        name: skill.name,
                        directory: skill.directory,
                    } satisfies LoadResult, null, 2)
                }

                const activeContext = await readActiveContext(client, skillContext, marker, hash, runtime)

                if (activeContext.found) {
                    return JSON.stringify({
                        name: skill.name,
                        directory: skill.directory,
                    } satisfies LoadResult, null, 2)
                }

                const files = await listSkillFiles(fileSystem, skill)
                storeLiveDedupeCache(skillContext, identity, hash, checkedCache)
                return JSON.stringify({
                    name: skill.name,
                    directory: skill.directory,
                    output: renderSkillContent(marker, skill, files),
                } satisfies LoadResult, null, 2)
            }
            catch (error) {
                return createAbortResponse("load skill", error)
            }
        },
    })
}
