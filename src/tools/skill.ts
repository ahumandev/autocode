import type { OpencodeClient } from "@opencode-ai/sdk"
import { tool } from "@opencode-ai/plugin"
import { createHash } from "crypto"
import { readFile, readdir } from "fs/promises"
import path from "path"
import { getGeneratedSkillsRoot } from "@/skills"
import { isMissingFile, resolveAgentsStorageRoot } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse, flattenError } from "@/utils/tools"

type FileSystem = {
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    readdir: (filePath: string, options: { withFileTypes: true }) => Promise<Array<{ isDirectory: () => boolean, isFile: () => boolean, name: string }>>
}

type SkillLoadArgs = {
    name?: unknown
    reference?: unknown
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

function validateSkillLoadArgs(args: SkillLoadArgs): { name: string, reference?: string } | { error: string, instruction: string } {
    const unexpectedArgs = Object.keys(args).filter((key) => key !== "name" && key !== "reference")
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

    if (args.reference !== undefined && (typeof args.reference !== "string" || !args.reference.trim())) {
        return {
            error: "Invalid reference. Reference must be a non-empty string when provided.",
            instruction: "Retry with a valid reference path or omit the reference argument.",
        }
    }

    return { name: args.name.trim(), reference: typeof args.reference === "string" ? args.reference.trim() : undefined }
}

function isPathWithinSkillDirectory(absolutePath: string, skillDirectory: string): boolean {
    const normalizedDirectory = path.resolve(skillDirectory)
    const normalizedPath = path.resolve(absolutePath)
    const directoryWithSeparator = normalizedDirectory.endsWith(path.sep) ? normalizedDirectory : normalizedDirectory + path.sep
    return normalizedPath === normalizedDirectory || normalizedPath.startsWith(directoryWithSeparator)
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
        // Narrow autocode root first so loose .md files at its root are collected.
        { path: path.resolve(getGeneratedSkillsRoot()), inferNestedNames: false },
        // Search the parent of all plugin skill installs so ANY plugin's skills
        // (e.g. ~/.agents/skills/autocode/..., ~/.agents/skills/<other-plugin>/...) are loadable.
        // Permission filtering stays in the framework's permission.skill block.
        { path: path.dirname(path.resolve(getGeneratedSkillsRoot())), inferNestedNames: true },
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

function renderSkillContent(marker: string, skill: LoadedSkill): string {
    return [
        marker,
        `<skill_content name="${skill.name}">`,
        skill.content.trim(),
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
        description: "Before starting work: load all applicable skills (not yet loaded) or skills needed by current step from \`<available_skills>\` block ONLY.",
        args: {
            name: tool.schema.string().describe("Must exactly match \`<name>\` from \`<available_skills>\` block in system prompt. If name only appears in agent prompt body (e.g. \`Task \`foo\`\`), it is a subagent - use \`task\` tool instead."),
            reference: tool.schema.string().optional().describe("Relative file path matching link in SKILL.md content exactly, to read a reference file instead of the main SKILL.md content. Example: reference/template.xml"),
        },
        async execute(args, context) {
            const validatedArgs = validateSkillLoadArgs(args)
            if ("error" in validatedArgs) {
                return createRetryResponse("load skill", validatedArgs.error, validatedArgs.instruction)
            }

            const skillContext = context as SkillLoadContext
            let skill: LoadedSkill | undefined
            try {
                skill = await loadSkill(fileSystem, skillContext, validatedArgs.name)
            }
            catch {
                return createRetryResponse(
                    "load skill",
                    `Skill ${validatedArgs.name} is unavailable.`,
                    `Try another skill or skip ${validatedArgs.name} skill.`,
                )
            }

            try {
                if (skill === undefined) {
                    return createRetryResponse(
                        "load skill",
                        buildSkillNotFoundError(validatedArgs.name),
                        "Retry with a skill name from the available skills list.",
                    )
                }

                if (validatedArgs.reference !== undefined) {
                    const targetFilePath = path.resolve(skill.directory, validatedArgs.reference)
                    if (!isPathWithinSkillDirectory(targetFilePath, skill.directory)) {
                        return createRetryResponse(
                            "load skill",
                            `Invalid reference: "${validatedArgs.reference}" escapes the skill directory.`,
                            "Provide a reference path that resolves within the skill directory.",
                        )
                    }

                    try {
                        return await fileSystem.readFile(targetFilePath, "utf8")
                    }
                    catch (error) {
                        if (isMissingFile(error)) {
                            return createAbortResponse("load skill", `File not found: ${validatedArgs.reference}`)
                        }
                        return createAbortResponse("load skill", error)
                    }
                }

                const identity = buildAutocodeSkillLoadIdentity(skill.name)
                const hash = buildAutocodeSkillLoadHash(identity, skill)
                const marker = buildAutocodeSkillLoadMarker(identity, hash)
                const checkedCache = checkLiveDedupeCache(skillContext, identity, hash)

                if (checkedCache.hit) {
                    return ""
                }

                const activeContext = await readActiveContext(client, skillContext, marker, hash, runtime)

                if (activeContext.found) {
                    return ""
                }

                storeLiveDedupeCache(skillContext, identity, hash, checkedCache)
                return renderSkillContent(marker, skill)
            }
            catch (error) {
                return createAbortResponse("load skill", error)
            }
        },
    })
}
