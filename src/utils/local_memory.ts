import path from "node:path"
import type { Dirent } from "node:fs"
import { resolveAgentsStorageRoot } from "./jobs"
import { flattenError } from "./tools"
import type { JobToolFileSystem, SessionJobContext } from "./jobs"

export const localMemoryDirectoryName = ".opencode/autocode/memories"
export const localMemoryMaximumXmlCharacters = 4_000
export const explicitLocalMemoryMaximumXmlCharacters = 7_000
export const localMemoryForgetRemovalConcurrency = 8

export type LocalMemory = {
    id: string
    aliases?: readonly string[]
    context?: string
    memory: string
    positive_example?: string
    negative_example?: string
    references?: readonly string[]
}

export type StoredLocalMemory = Required<Pick<LocalMemory, "id" | "memory">> & Omit<LocalMemory, "id" | "memory"> & {
    timestamp: string
    filename: string
}

export type LocalMemoryFileSystem = Pick<JobToolFileSystem, "mkdir" | "readFile" | "readdir" | "rename" | "rm" | "writeFile">

export type LocalMemoryErrorCode = "INVALID_MEMORY" | "INVALID_TIMESTAMP" | "INVALID_FILENAME" | "MALFORMED_MEMORY" | "FILENAME_TOO_LONG" | "FILESYSTEM"

export class LocalMemoryError extends Error {
    readonly code: LocalMemoryErrorCode

    constructor(code: LocalMemoryErrorCode, message: string) {
        super(message)
        this.name = "LocalMemoryError"
        this.code = code
    }
}

export type SaveLocalMemoryOptions = {
    now?: () => Date
    temporary_suffix?: () => string
}

export type SaveLocalMemoryResult = {
    memory: StoredLocalMemory
    path: string
    trace: readonly LocalMemorySaveTrace[]
}

export type LocalMemorySaveTrace = {
    reason: "saved"
    replaced_same_timestamp_versions: number
}

export type LoadLocalMemoriesResult = {
    memories: readonly StoredLocalMemory[]
    trace: readonly LocalMemoryLoadTrace[]
}

export type LocalMemoryLoadTrace = {
    reason: "duplicate_version_drop"
    timestamp: string
    retained_timestamp: string
}

export type LocalMemorySelectionInput = {
    prompt: string
    loaded_ids: readonly string[]
    timing?: LocalMemoryTimingCollector
}

export type LocalMemoryTimingCollector = {
    directory_listing: number
    body_read: number
    parsing_normalization: number
    selection_matching: number
    body_render_sizing: number
}

export type SelectedLocalMemory = {
    memory: StoredLocalMemory
    matched_keyword: string
    matched_source: "id" | "alias" | "context"
}

export type LocalMemorySelectionTrace = LocalMemoryLoadTrace | {
    reason: "selected"
    source: "id" | "alias" | "context"
    timestamp: string
} | {
    reason: "loaded_id_skip"
    timestamp: string
} | {
    reason: "no_match"
} | {
    reason: "budget_stop"
    selected_characters: number
    next_block_characters: number
}

export type SelectLocalMemoriesResult = {
    memories: readonly SelectedLocalMemory[]
    xml: string
    characters: number
    trace: readonly LocalMemorySelectionTrace[]
}

export type LocalMemoryRecallTrace = LocalMemoryLoadTrace | {
    reason: "selected"
    source: "id" | "alias" | "context"
    query_term: string
    timestamp: string
} | {
    reason: "no_match"
} | {
    reason: "budget_stop"
    selected_characters: number
    next_block_characters: number
}

export type RecallLocalMemoriesResult = {
    memories: readonly SelectedLocalMemory[]
    xml: string
    characters: number
    trace: readonly LocalMemoryRecallTrace[]
}

export type DeletedLocalMemory = {
    filename: string
    path: string
}

export type FailedLocalMemoryDeletion = DeletedLocalMemory & {
    error: LocalMemoryError
}

export type ForgetLocalMemoryResult = {
    normalized_id: string
    deleted: readonly DeletedLocalMemory[]
    failed: readonly FailedLocalMemoryDeletion[]
}

export type LocalMemoryXmlBudgetResult = {
    blocks: readonly string[]
    characterCount: number
    stoppedAtIndex?: number
}

export const trustedLocalMemoryXmlMarker = Object.freeze({
    element_name: "autocode:memory",
    namespace_uri: "https://autocode.dev/xml/local-memory",
    version: "1",
    owner: "autocode",
})

export type TrustedLocalMemoryXmlBlock = {
    id_keyword: string
    matched_keyword: string
    xml: string
}

type LocalMemoryBody = {
    timestamp: string
    id: string
    aliases: string[]
    context: string
    memory: string
    positive_example?: string
    negative_example?: string
    references?: string[]
}

type MatchKeyword = {
    display: string
    normalized: string
    source: "id" | "alias" | "context"
}

type ContextMatch = {
    memory: StoredLocalMemory
    keyword: MatchKeyword
    position: number
}

const memoryMetadataPrefix = "<!-- autocode-local-memory:v1\n"
const memoryMetadataSuffix = "\n-->\n"
const memorySectionOrder = ["memory", "positive_example", "negative_example", "references"] as const
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})h(\d{2})s(\d{2})$/
const filenameReservedPattern = /[<>:"/\\|?*\u0000-\u001F]/u
const localMemoryXmlSeparator = "\n"
let temporarySequence = 0

export function getLocalMemoryDirectory(context: Pick<SessionJobContext, "directory" | "worktree">): string {
    return path.join(resolveAgentsStorageRoot(context), localMemoryDirectoryName)
}

/** NFKC, trim, collapse every Unicode whitespace run to one space, then lowercase deterministically. */
export function normalizeLocalMemoryMatchValue(value: string): string {
    return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase()
}

export function applyLocalMemoryXmlBudget(blocks: readonly string[]): LocalMemoryXmlBudgetResult {
    return applyLocalMemoryXmlBudgetLimit(blocks, localMemoryMaximumXmlCharacters)
}

function applyLocalMemoryXmlBudgetLimit(blocks: readonly string[], maximumCharacters: number): LocalMemoryXmlBudgetResult {
    const accepted: string[] = []
    let characterCount = 0
    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]
        if (typeof block !== "string") throw new LocalMemoryError("INVALID_MEMORY", "Local memory XML blocks must be strings.")
        const nextCharacterCount = characterCount + (accepted.length === 0 ? 0 : localMemoryXmlSeparator.length) + block.length
        if (nextCharacterCount > maximumCharacters) {
            return { blocks: accepted, characterCount, stoppedAtIndex: index }
        }
        accepted.push(block)
        characterCount = nextCharacterCount
        if (characterCount === maximumCharacters) {
            return { blocks: accepted, characterCount, stoppedAtIndex: index + 1 }
        }
    }
    return { blocks: accepted, characterCount }
}

export function formatLocalMemoryTimestamp(date: Date): string {
    if (Number.isNaN(date.getTime())) throw new LocalMemoryError("INVALID_TIMESTAMP", "Local memory timestamp must be a valid date.")
    if (date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9_999) throw new LocalMemoryError("INVALID_TIMESTAMP", "Local memory timestamp year must fit YYYY.")
    const pad = (value: number): string => String(value).padStart(2, "0")
    return `${date.getUTCFullYear().toString().padStart(4, "0")}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}h${pad(date.getUTCMinutes())}s${pad(date.getUTCSeconds())}`
}

export function formatLocalMemoryFilename(timestamp: string, memory: Pick<LocalMemory, "id" | "aliases" | "context">): string {
    assertTimestamp(timestamp)
    const metadata = normalizeMemoryMetadata(memory)
    const aliases = metadata.aliases.map((alias: string): string => encodeFilenamePart(alias))
    const identifierGroup = [encodeFilenamePart(metadata.id), ...aliases].join(",")
    const contextSuffix = metadata.context ? `;${encodeFilenamePart(metadata.context, true)}` : ""
    const filename = `${timestamp} ${identifierGroup}${contextSuffix}.md`
    assertFilenameLength(filename)
    return filename
}

export function parseLocalMemoryFilename(filename: string): { timestamp: string, id: string, aliases: string[], context: string } {
    if (!filename.endsWith(".md")) throw new LocalMemoryError("INVALID_FILENAME", `Local memory filename must end with .md: ${filename}`)
    const stem = filename.slice(0, -3)
    if (filenameReservedPattern.test(stem) || stem.includes("\n") || stem.includes("\r")) {
        throw new LocalMemoryError("INVALID_FILENAME", `Local memory filename contains reserved characters: ${filename}`)
    }
    const timestamp = stem.slice(0, 19)
    if (stem.charAt(19) !== " ") throw new LocalMemoryError("INVALID_FILENAME", `Local memory filename has invalid timestamp separator: ${filename}`)
    assertTimestamp(timestamp)
    const encodedMetadata = stem.slice(20)
    const separatorIndex = encodedMetadata.indexOf(";")
    if (separatorIndex !== -1 && encodedMetadata.indexOf(";", separatorIndex + 1) !== -1) {
        throw new LocalMemoryError("INVALID_FILENAME", `Local memory filename has multiple context separators: ${filename}`)
    }
    const encodedIdentifiers = separatorIndex === -1 ? encodedMetadata : encodedMetadata.slice(0, separatorIndex)
    const encodedContext = separatorIndex === -1 ? undefined : encodedMetadata.slice(separatorIndex + 1)
    const groups = encodedIdentifiers.split(",")
    if (!groups[0] || groups.some((group: string): boolean => !group)) {
        throw new LocalMemoryError("INVALID_FILENAME", `Local memory filename has an empty identifier: ${filename}`)
    }
    if (encodedContext === "") throw new LocalMemoryError("INVALID_FILENAME", `Local memory filename has an empty context: ${filename}`)
    const id = decodeFilenamePart(groups[0], filename)
    const aliases = groups.slice(1).map((group: string): string => decodeFilenamePart(group, filename))
    const context = encodedContext === undefined ? "" : decodeFilenamePart(encodedContext, filename, true)
    normalizeMemoryMetadata({ id, aliases, context })
    return { timestamp, id, aliases, context }
}

export async function saveLocalMemory(
    fileSystem: LocalMemoryFileSystem,
    context: Pick<SessionJobContext, "directory" | "worktree">,
    memory: LocalMemory,
    options: SaveLocalMemoryOptions = {},
): Promise<SaveLocalMemoryResult> {
    const metadata = normalizeMemoryMetadata(memory)
    const timestamp = formatLocalMemoryTimestamp((options.now ?? (() => new Date()))())
    const filename = formatLocalMemoryFilename(timestamp, metadata)
    const stored = createStoredMemory(memory, metadata, timestamp, filename)
    const directory = getLocalMemoryDirectory(context)
    await runFileSystem("create local memory directory", async (): Promise<void> => {
        await fileSystem.mkdir(directory, { recursive: true })
    })
    const existingNames = await readMemoryFileNames(fileSystem, directory)
    const matchingPaths: string[] = []
    for (const name of existingNames) {
        const existing = parseLocalMemoryFilename(name)
        if (existing.timestamp === timestamp && normalizeLocalMemoryMatchValue(existing.id) === normalizeLocalMemoryMatchValue(stored.id)) {
            matchingPaths.push(path.join(directory, name))
        }
    }
    const targetPath = path.join(directory, filename)
    const temporaryPath = path.join(directory, createTemporaryFilename(options.temporary_suffix))
    try {
        await runFileSystem("write local memory temporary file", async (): Promise<void> => {
            await fileSystem.writeFile(temporaryPath, serializeMemoryBody(stored))
        })
        for (const matchingPath of matchingPaths) {
            await runFileSystem("remove same-timestamp local memory", async (): Promise<void> => {
                await fileSystem.rm(matchingPath, { force: true })
            })
        }
        await runFileSystem("rename local memory temporary file", async (): Promise<void> => {
            await fileSystem.rename(temporaryPath, targetPath)
        })
    }
    catch (error) {
        await removeTemporaryFile(fileSystem, temporaryPath)
        throw error
    }
    return {
        memory: stored,
        path: targetPath,
        trace: [{ reason: "saved", replaced_same_timestamp_versions: matchingPaths.length }],
    }
}

export async function loadLocalMemories(
    fileSystem: LocalMemoryFileSystem,
    context: Pick<SessionJobContext, "directory" | "worktree">,
    timing?: LocalMemoryTimingCollector,
): Promise<LoadLocalMemoriesResult> {
    const directory = getLocalMemoryDirectory(context)
    const names = await readMemoryFileNames(fileSystem, directory, timing)
    const parsed: StoredLocalMemory[] = []
    for (const filename of names) {
        const filenameMetadata = measureLocalMemoryTiming(timing, "parsing_normalization", (): { timestamp: string, id: string, aliases: string[], context: string } => parseLocalMemoryFilename(filename))
        const content = await runFileSystem("read local memory", async (): Promise<string> => await measureLocalMemoryTimingAsync(timing, "body_read", async (): Promise<string> => await fileSystem.readFile(path.join(directory, filename), "utf8")))
        const memory = measureLocalMemoryTiming(timing, "parsing_normalization", (): StoredLocalMemory => {
            const body = parseMemoryBody(content, filenameMetadata, filename)
            assertBodyMatchesFilename(body, filenameMetadata, filename)
            return {
                timestamp: filenameMetadata.timestamp,
                filename,
                id: body.id,
                aliases: body.aliases,
                context: body.context || undefined,
                memory: body.memory,
                positive_example: body.positive_example,
                negative_example: body.negative_example,
                references: body.references,
            }
        })
        parsed.push(memory)
    }
    return measureLocalMemoryTiming(timing, "parsing_normalization", (): LoadLocalMemoriesResult => {
        parsed.sort(compareStoredMemories)
        const retained: StoredLocalMemory[] = []
        const trace: LocalMemoryLoadTrace[] = []
        const retainedByIdentifier = new Map<string, StoredLocalMemory>()
        for (const memory of parsed) {
            const normalizedId = normalizeLocalMemoryMatchValue(memory.id)
            const current = retainedByIdentifier.get(normalizedId)
            if (current) {
                trace.push({ reason: "duplicate_version_drop", timestamp: memory.timestamp, retained_timestamp: current.timestamp })
                continue
            }
            retainedByIdentifier.set(normalizedId, memory)
            retained.push(memory)
        }
        return { memories: retained, trace }
    })
}

export async function selectLocalMemories(
    fileSystem: LocalMemoryFileSystem,
    context: Pick<SessionJobContext, "directory" | "worktree">,
    input: LocalMemorySelectionInput,
): Promise<SelectLocalMemoriesResult> {
    const loaded = await loadLocalMemories(fileSystem, context, input.timing)
    const trace: LocalMemorySelectionTrace[] = [...loaded.trace]
    const candidates = measureLocalMemoryTiming(input.timing, "selection_matching", (): SelectedLocalMemory[] => {
        const normalizedPrompt = normalizeLocalMemoryMatchValue(input.prompt)
        const loadedIds = new Set(input.loaded_ids.map(normalizeLocalMemoryMatchValue).filter(Boolean))
        const eligible: StoredLocalMemory[] = []
        for (const memory of loaded.memories) {
            if (loadedIds.has(normalizeLocalMemoryMatchValue(memory.id))) {
                trace.push({ reason: "loaded_id_skip", timestamp: memory.timestamp })
                continue
            }
            eligible.push(memory)
        }
        return findSelectionCandidates(eligible, normalizedPrompt)
    })
    if (candidates.length === 0) trace.push({ reason: "no_match" })
    const { renderedBlocks, budget } = measureLocalMemoryTiming(input.timing, "body_render_sizing", (): { renderedBlocks: string[], budget: LocalMemoryXmlBudgetResult } => {
        const renderedBlocks = candidates.map((candidate: SelectedLocalMemory): string => renderLocalMemoryXml(candidate.memory, candidate.matched_keyword))
        return { renderedBlocks, budget: applyLocalMemoryXmlBudget(renderedBlocks) }
    })
    const selected = candidates.slice(0, budget.blocks.length)
    for (const candidate of selected) {
        trace.push({ reason: "selected", source: candidate.matched_source, timestamp: candidate.memory.timestamp })
    }
    if (budget.stoppedAtIndex !== undefined) {
        trace.push({
            reason: "budget_stop",
            selected_characters: budget.characterCount,
            next_block_characters: budget.characterCount === localMemoryMaximumXmlCharacters ? 0 : renderedBlocks[budget.stoppedAtIndex]?.length ?? 0,
        })
    }
    return { memories: selected, xml: budget.blocks.join(localMemoryXmlSeparator), characters: budget.characterCount, trace }
}

export async function recallLocalMemories(
    fileSystem: LocalMemoryFileSystem,
    context: Pick<SessionJobContext, "directory" | "worktree">,
    terms: readonly string[],
    maximumXmlCharacters: number = explicitLocalMemoryMaximumXmlCharacters,
): Promise<RecallLocalMemoriesResult> {
    assertLocalMemoryXmlBudget(maximumXmlCharacters)
    const normalizedTerms = normalizeRecallTerms(terms)
    const loaded = await loadLocalMemories(fileSystem, context)
    const trace: LocalMemoryRecallTrace[] = [...loaded.trace]
    const selected: SelectedLocalMemory[] = []
    const renderedBlocks: string[] = []
    const selectedIds = new Set<string>()
    let characters = 0
    let hasCandidates = false
    for (const term of normalizedTerms) {
        const candidates = findExplicitRecallCandidatesForTerm(loaded.memories, term, selectedIds)
        if (candidates.length > 0) hasCandidates = true
        for (const candidate of candidates) {
            const block = renderLocalMemoryXml(candidate.memory, candidate.matched_keyword)
            const nextCharacters = characters + (renderedBlocks.length === 0 ? 0 : localMemoryXmlSeparator.length) + block.length
            if (nextCharacters > maximumXmlCharacters) {
                trace.push({ reason: "budget_stop", selected_characters: characters, next_block_characters: block.length })
                return { memories: selected, xml: renderedBlocks.join(localMemoryXmlSeparator), characters, trace }
            }
            selected.push(candidate)
            renderedBlocks.push(block)
            selectedIds.add(normalizeLocalMemoryMatchValue(candidate.memory.id))
            characters = nextCharacters
            trace.push({ reason: "selected", source: candidate.matched_source, query_term: candidate.matched_keyword, timestamp: candidate.memory.timestamp })
            if (characters === maximumXmlCharacters) {
                trace.push({ reason: "budget_stop", selected_characters: characters, next_block_characters: 0 })
                return { memories: selected, xml: renderedBlocks.join(localMemoryXmlSeparator), characters, trace }
            }
        }
    }
    if (!hasCandidates) trace.push({ reason: "no_match" })
    return { memories: selected, xml: renderedBlocks.join(localMemoryXmlSeparator), characters, trace }
}

export async function forgetLocalMemory(
    fileSystem: LocalMemoryFileSystem,
    context: Pick<SessionJobContext, "directory" | "worktree">,
    primaryId: string,
): Promise<ForgetLocalMemoryResult> {
    const normalizedId = normalizeForgetPrimaryId(primaryId)
    const directory = getLocalMemoryDirectory(context)
    const filenames = await readMemoryFileNames(fileSystem, directory)
    const matches: DeletedLocalMemory[] = []
    for (const filename of filenames) {
        const metadata = parseLocalMemoryFilename(filename)
        if (normalizeLocalMemoryMatchValue(metadata.id) === normalizedId) {
            matches.push({ filename, path: path.join(directory, filename) })
        }
    }
    const attempts = await removeLocalMemoryFiles(fileSystem, matches)
    const deleted: DeletedLocalMemory[] = []
    const failed: FailedLocalMemoryDeletion[] = []
    for (const attempt of attempts) {
        if (attempt.error === undefined) deleted.push(attempt.file)
        else failed.push({ ...attempt.file, error: attempt.error })
    }
    return { normalized_id: normalizedId, deleted, failed }
}

export function renderLocalMemoryXml(memory: LocalMemory | StoredLocalMemory, matchedKeyword: string): string {
    const marker = trustedLocalMemoryXmlMarker
    const attributes = `xmlns:autocode="${marker.namespace_uri}" autocode:version="${marker.version}" autocode:owner="${marker.owner}" id_keyword="${escapeXml(memory.id)}" matched_keyword="${escapeXml(matchedKeyword)}"`
    const body = [
        `<memory>${escapeXml(memory.memory)}</memory>`,
        memory.positive_example === undefined ? "" : `<positive_example>${escapeXml(memory.positive_example)}</positive_example>`,
        memory.negative_example === undefined ? "" : `<negative_example>${escapeXml(memory.negative_example)}</negative_example>`,
        memory.references === undefined ? "" : `<references>${memory.references.map((reference: string): string => `<reference>${escapeXml(reference)}</reference>`).join("")}</references>`,
    ].filter(Boolean).join("")
    return `<${marker.element_name} ${attributes}>${body}</${marker.element_name}>`
}

export function parseTrustedLocalMemoryXmlBlocks(xml: string): TrustedLocalMemoryXmlBlock[] {
    const blocks: TrustedLocalMemoryXmlBlock[] = []
    const pattern = /<autocode:memory\b([^>]*)>([\s\S]*?)<\/autocode:memory>/gu
    for (const match of xml.matchAll(pattern)) {
        const attributes = parseXmlAttributes(match[1])
        if (!attributes || attributes["xmlns:autocode"] !== trustedLocalMemoryXmlMarker.namespace_uri || attributes["autocode:version"] !== trustedLocalMemoryXmlMarker.version || attributes["autocode:owner"] !== trustedLocalMemoryXmlMarker.owner || attributes.id_keyword === undefined || attributes.matched_keyword === undefined) continue
        blocks.push({
            id_keyword: unescapeXml(attributes.id_keyword),
            matched_keyword: unescapeXml(attributes.matched_keyword),
            xml: match[0],
        })
    }
    return blocks
}

export function isTrustedLocalMemoryXmlBlock(xml: string): boolean {
    const blocks = parseTrustedLocalMemoryXmlBlocks(xml)
    return blocks.length === 1 && blocks[0].xml === xml
}

function normalizeMemoryMetadata(memory: Pick<LocalMemory, "id" | "aliases" | "context">): { id: string, aliases: string[], context: string } {
    if (typeof memory.id !== "string" || !memory.id.trim()) throw new LocalMemoryError("INVALID_MEMORY", "Local memory ID must be nonempty.")
    if (memory.aliases !== undefined && !Array.isArray(memory.aliases)) throw new LocalMemoryError("INVALID_MEMORY", "Local memory aliases must be an array.")
    const aliases = memory.aliases === undefined ? [] : [...memory.aliases]
    if (aliases.some((alias: string): boolean => typeof alias !== "string" || !alias.trim())) {
        throw new LocalMemoryError("INVALID_MEMORY", "Local memory aliases must be nonempty strings.")
    }
    if (memory.context !== undefined && typeof memory.context !== "string") throw new LocalMemoryError("INVALID_MEMORY", "Local memory context must be a string.")
    return { id: memory.id, aliases, context: memory.context ?? "" }
}

function createStoredMemory(memory: LocalMemory, metadata: { id: string, aliases: string[], context: string }, timestamp: string, filename: string): StoredLocalMemory {
    if (typeof memory.memory !== "string") throw new LocalMemoryError("INVALID_MEMORY", "Local memory body must be a string.")
    if (memory.positive_example !== undefined && typeof memory.positive_example !== "string") throw new LocalMemoryError("INVALID_MEMORY", "Local memory positive example must be a string.")
    if (memory.negative_example !== undefined && typeof memory.negative_example !== "string") throw new LocalMemoryError("INVALID_MEMORY", "Local memory negative example must be a string.")
    if (memory.references !== undefined && (!Array.isArray(memory.references) || memory.references.some((reference: string): boolean => typeof reference !== "string"))) {
        throw new LocalMemoryError("INVALID_MEMORY", "Local memory references must be strings.")
    }
    return {
        timestamp,
        filename,
        id: metadata.id,
        aliases: metadata.aliases,
        context: metadata.context || undefined,
        memory: memory.memory,
        positive_example: memory.positive_example,
        negative_example: memory.negative_example,
        references: memory.references === undefined ? undefined : [...memory.references],
    }
}

function serializeMemoryBody(memory: StoredLocalMemory): string {
    return memory.memory
}

function parseMemoryBody(content: string, filenameMetadata: Pick<LocalMemoryBody, "timestamp" | "id" | "aliases" | "context">, filename: string): LocalMemoryBody {
    if (!content.startsWith(memoryMetadataPrefix)) {
        return { ...filenameMetadata, aliases: [...filenameMetadata.aliases], memory: content }
    }
    const metadataEnd = content.indexOf(memoryMetadataSuffix, memoryMetadataPrefix.length)
    if (metadataEnd === -1) throw new LocalMemoryError("MALFORMED_MEMORY", `Local memory metadata is incomplete: ${filename}`)
    const metadata = parseMemoryMetadata(content.slice(memoryMetadataPrefix.length, metadataEnd), filename)
    const sections = parseMemorySections(content.slice(metadataEnd + memoryMetadataSuffix.length), filename)
    const memory = sections.memory
    if (typeof memory !== "string") throw new LocalMemoryError("MALFORMED_MEMORY", `Local memory body has invalid memory section: ${filename}`)
    if ((sections.positive_example !== undefined && typeof sections.positive_example !== "string") || (sections.negative_example !== undefined && typeof sections.negative_example !== "string") || (sections.references !== undefined && !isStringArray(sections.references))) {
        throw new LocalMemoryError("MALFORMED_MEMORY", `Local memory body has invalid optional sections: ${filename}`)
    }
    return {
        timestamp: metadata.timestamp,
        id: metadata.id,
        aliases: metadata.aliases,
        context: metadata.context,
        memory,
        positive_example: sections.positive_example,
        negative_example: sections.negative_example,
        references: sections.references,
    }
}

function parseMemoryMetadata(json: string, filename: string): { timestamp: string, id: string, aliases: string[], context: string } {
    if (json.includes("\n") || json.includes("\r")) throw new LocalMemoryError("MALFORMED_MEMORY", `Local memory metadata must contain one JSON record: ${filename}`)
    const parsed = parseMemoryJson(json, "metadata", filename)
    if (!isRecord(parsed) || !hasOnlyMemoryMetadataKeys(parsed) || typeof parsed.timestamp !== "string" || typeof parsed.id !== "string" || !isStringArray(parsed.aliases) || typeof parsed.context !== "string") {
        throw new LocalMemoryError("MALFORMED_MEMORY", `Local memory metadata has invalid fields: ${filename}`)
    }
    assertTimestamp(parsed.timestamp)
    normalizeMemoryMetadata({ id: parsed.id, aliases: parsed.aliases, context: parsed.context })
    return { timestamp: parsed.timestamp, id: parsed.id, aliases: parsed.aliases, context: parsed.context }
}

function parseMemorySections(content: string, filename: string): Record<typeof memorySectionOrder[number], unknown> {
    const sections: Partial<Record<typeof memorySectionOrder[number], unknown>> = {}
    const pattern = /## (memory|positive_example|negative_example|references)\n```json\n([^\r\n]*)\n```\n/gu
    let offset = 0
    let previousHeadingIndex = -1
    for (const match of content.matchAll(pattern)) {
        if (match.index !== offset) throw new LocalMemoryError("MALFORMED_MEMORY", `Local memory sections are malformed: ${filename}`)
        const heading = match[1] as typeof memorySectionOrder[number]
        const headingIndex = memorySectionOrder.indexOf(heading)
        if (headingIndex <= previousHeadingIndex) throw new LocalMemoryError("MALFORMED_MEMORY", `Local memory sections are out of order: ${filename}`)
        sections[heading] = parseMemoryJson(match[2], `${heading} section`, filename)
        previousHeadingIndex = headingIndex
        offset += match[0].length
    }
    if (offset !== content.length || sections.memory === undefined) throw new LocalMemoryError("MALFORMED_MEMORY", `Local memory sections are incomplete: ${filename}`)
    return sections as Record<typeof memorySectionOrder[number], unknown>
}

function parseMemoryJson(json: string, description: string, filename: string): unknown {
    try {
        return JSON.parse(json)
    }
    catch {
        throw new LocalMemoryError("MALFORMED_MEMORY", `Local memory ${description} contains invalid JSON: ${filename}`)
    }
}

function assertBodyMatchesFilename(body: LocalMemoryBody, filename: { timestamp: string, id: string, aliases: string[], context: string }, name: string): void {
    if (body.timestamp !== filename.timestamp || body.id !== filename.id || body.context !== filename.context || body.aliases.length !== filename.aliases.length || body.aliases.some((alias: string, index: number): boolean => alias !== filename.aliases[index])) {
        throw new LocalMemoryError("MALFORMED_MEMORY", `Local memory filename and body conflict: ${name}`)
    }
}

function findSelectionCandidates(memories: readonly StoredLocalMemory[], normalizedPrompt: string): SelectedLocalMemory[] {
    const selected: SelectedLocalMemory[] = []
    const selectedIds = new Set<string>()
    for (const memory of memories) {
        const match = getSpecificKeywords(memory).find((keyword: MatchKeyword): boolean => findPhrasePosition(normalizedPrompt, keyword.normalized) !== -1)
        if (!match) continue
        selected.push({ memory, matched_keyword: match.display, matched_source: match.source })
        selectedIds.add(normalizeLocalMemoryMatchValue(memory.id))
    }
    const contextMatches: ContextMatch[] = []
    for (const memory of memories) {
        if (selectedIds.has(normalizeLocalMemoryMatchValue(memory.id))) continue
        const keyword = getContextKeyword(memory)
        if (!keyword) continue
        const position = findPhrasePosition(normalizedPrompt, keyword.normalized)
        if (position !== -1) contextMatches.push({ memory, keyword, position })
    }
    contextMatches.sort((left: ContextMatch, right: ContextMatch): number => left.position - right.position || compareStoredMemories(left.memory, right.memory))
    for (const match of contextMatches) {
        selected.push({ memory: match.memory, matched_keyword: match.keyword.display, matched_source: "context" })
    }
    return selected
}

function findExplicitRecallCandidatesForTerm(memories: readonly StoredLocalMemory[], normalizedTerm: string, excludedIds: ReadonlySet<string>): SelectedLocalMemory[] {
    const selected: SelectedLocalMemory[] = []
    const selectedIds = new Set(excludedIds)
    for (const source of ["id", "alias", "context"] as const) {
        for (const memory of memories) {
            const normalizedId = normalizeLocalMemoryMatchValue(memory.id)
            if (selectedIds.has(normalizedId) || !memoryMatchesRecallTerm(memory, source, normalizedTerm)) continue
            selected.push({ memory, matched_keyword: normalizedTerm, matched_source: source })
            selectedIds.add(normalizedId)
        }
    }
    return selected
}

function memoryMatchesRecallTerm(memory: StoredLocalMemory, source: "id" | "alias" | "context", normalizedTerm: string): boolean {
    if (source === "id") return findPhrasePosition(normalizeLocalMemoryMatchValue(memory.id), normalizedTerm) !== -1
    if (source === "alias") {
        return (memory.aliases ?? []).some((alias: string): boolean => findPhrasePosition(normalizeLocalMemoryMatchValue(alias), normalizedTerm) !== -1)
    }
    return memory.context !== undefined && findPhrasePosition(normalizeLocalMemoryMatchValue(memory.context), normalizedTerm) !== -1
}

function getSpecificKeywords(memory: StoredLocalMemory): MatchKeyword[] {
    const keywords: MatchKeyword[] = []
    const seen = new Set<string>()
    for (const candidate of [{ value: memory.id, source: "id" as const }, ...(memory.aliases ?? []).map((value: string): { value: string, source: "alias" } => ({ value, source: "alias" }))]) {
        const normalized = normalizeLocalMemoryMatchValue(candidate.value)
        if (!normalized || seen.has(normalized)) continue
        seen.add(normalized)
        keywords.push({ display: candidate.value, normalized, source: candidate.source })
    }
    return keywords
}

function getContextKeyword(memory: StoredLocalMemory): MatchKeyword | undefined {
    if (!memory.context) return undefined
    const normalized = normalizeLocalMemoryMatchValue(memory.context)
    if (!normalized || getSpecificKeywords(memory).some((keyword: MatchKeyword): boolean => keyword.normalized === normalized)) return undefined
    return { display: memory.context, normalized, source: "context" }
}

function findPhrasePosition(normalizedPrompt: string, normalizedKeyword: string): number {
    if (!normalizedPrompt || !normalizedKeyword) return -1
    const escapedKeyword = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}\\p{M}_$])(${escapedKeyword})(?=$|[^\\p{L}\\p{N}\\p{M}_$])`, "u")
    const match = pattern.exec(normalizedPrompt)
    if (!match || match.index === undefined) return -1
    return match.index + match[1].length
}

function normalizeRecallTerms(terms: readonly string[]): string[] {
    if (!Array.isArray(terms) || terms.some((term: string): boolean => typeof term !== "string")) {
        throw new LocalMemoryError("INVALID_MEMORY", "Local memory recall terms must be strings.")
    }
    return terms.map(normalizeLocalMemoryMatchValue).filter(Boolean)
}

function assertLocalMemoryXmlBudget(maximumCharacters: number): void {
    if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 0) {
        throw new LocalMemoryError("INVALID_MEMORY", "Local memory XML budget must be a nonnegative safe integer.")
    }
}

function normalizeForgetPrimaryId(primaryId: string): string {
    if (typeof primaryId !== "string") throw new LocalMemoryError("INVALID_MEMORY", "Local memory primary ID must be a string.")
    const normalizedId = normalizeLocalMemoryMatchValue(primaryId)
    if (!normalizedId) throw new LocalMemoryError("INVALID_MEMORY", "Local memory primary ID must be nonempty.")
    return normalizedId
}

type LocalMemoryRemovalAttempt = {
    file: DeletedLocalMemory
    error?: LocalMemoryError
}

async function removeLocalMemoryFiles(fileSystem: LocalMemoryFileSystem, files: readonly DeletedLocalMemory[]): Promise<LocalMemoryRemovalAttempt[]> {
    const attempts: LocalMemoryRemovalAttempt[] = new Array(files.length)
    let nextIndex = 0
    const removeNext = async (): Promise<void> => {
        while (true) {
            const index = nextIndex
            nextIndex += 1
            if (index >= files.length) return
            const file = files[index]
            try {
                await runFileSystem("remove local memory", async (): Promise<void> => {
                    await fileSystem.rm(file.path, { force: true })
                })
                attempts[index] = { file }
            }
            catch (error) {
                attempts[index] = { file, error: asLocalMemoryError("remove local memory", error) }
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(localMemoryForgetRemovalConcurrency, files.length) }, (): Promise<void> => removeNext()))
    return attempts
}

function compareStoredMemories(left: StoredLocalMemory, right: StoredLocalMemory): number {
    if (left.timestamp !== right.timestamp) return left.timestamp < right.timestamp ? 1 : -1
    if (left.filename === right.filename) return 0
    return left.filename < right.filename ? 1 : -1
}

function assertTimestamp(timestamp: string): void {
    const match = timestampPattern.exec(timestamp)
    if (!match) throw new LocalMemoryError("INVALID_TIMESTAMP", `Local memory timestamp is invalid: ${timestamp}`)
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hour, minute, second, 0)
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
        throw new LocalMemoryError("INVALID_TIMESTAMP", `Local memory timestamp is invalid: ${timestamp}`)
    }
}

function encodeFilenamePart(value: string, preserveCommas: boolean = false): string {
    return encodeURIComponent(value).replace(/%20/gu, " ").replace(/%2C/gu, preserveCommas ? "," : "%2C").replace(/[!'()*]/gu, (character: string): string => {
        const codePoint = character.codePointAt(0)
        return codePoint === undefined ? character : `%${codePoint.toString(16).toUpperCase().padStart(2, "0")}`
    })
}

function decodeFilenamePart(value: string, filename: string, preserveCommas: boolean = false): string {
    let decoded: string
    try {
        decoded = decodeURIComponent(value)
    }
    catch {
        throw new LocalMemoryError("INVALID_FILENAME", `Local memory filename has invalid escaping: ${filename}`)
    }
    if (encodeFilenamePart(decoded, preserveCommas) !== value) throw new LocalMemoryError("INVALID_FILENAME", `Local memory filename escaping is not canonical: ${filename}`)
    return decoded
}

function assertFilenameLength(filename: string): void {
    if (filename.length > 255 || Buffer.byteLength(filename, "utf8") > 255) {
        throw new LocalMemoryError("FILENAME_TOO_LONG", `Local memory filename exceeds platform limits: ${filename}`)
    }
}

function createTemporaryFilename(factory: (() => string) | undefined): string {
    const suffix = factory ? factory() : `${process.pid}-${temporarySequence += 1}`
    if (!suffix || /[\\/\u0000-\u001F]/u.test(suffix)) throw new LocalMemoryError("INVALID_MEMORY", "Local memory temporary suffix is invalid.")
    const filename = `.autocode-memory-${encodeFilenamePart(suffix)}.tmp`
    assertFilenameLength(filename)
    return filename
}

async function readMemoryFileNames(fileSystem: LocalMemoryFileSystem, directory: string, timing?: LocalMemoryTimingCollector): Promise<string[]> {
    let entries: string[] | Dirent[]
    try {
        entries = await measureLocalMemoryTimingAsync(timing, "directory_listing", async (): Promise<string[] | Dirent[]> => await fileSystem.readdir(directory, { withFileTypes: true }))
    }
    catch (error) {
        if (isMissingFile(error)) return []
        throwFileSystemError("read local memory directory", error)
    }
    return entries
        .filter((entry: string | Dirent): boolean => typeof entry === "string" || entry.isFile())
        .map((entry: string | Dirent): string => typeof entry === "string" ? entry : entry.name)
        .filter((name: string): boolean => name.endsWith(".md"))
        .sort((left: string, right: string): number => left.localeCompare(right))
}

function measureLocalMemoryTiming<T>(timing: LocalMemoryTimingCollector | undefined, stage: keyof LocalMemoryTimingCollector, operation: () => T): T {
    if (timing === undefined) return operation()
    const started = performance.now()
    try {
        return operation()
    }
    finally {
        timing[stage] += performance.now() - started
    }
}

async function measureLocalMemoryTimingAsync<T>(timing: LocalMemoryTimingCollector | undefined, stage: keyof LocalMemoryTimingCollector, operation: () => Promise<T>): Promise<T> {
    if (timing === undefined) return await operation()
    const started = performance.now()
    try {
        return await operation()
    }
    finally {
        timing[stage] += performance.now() - started
    }
}

async function runFileSystem<T>(action: string, operation: () => Promise<T>): Promise<T> {
    try {
        return await operation()
    }
    catch (error) {
        throwFileSystemError(action, error)
    }
}

async function removeTemporaryFile(fileSystem: LocalMemoryFileSystem, filePath: string): Promise<void> {
    try {
        await fileSystem.rm(filePath, { force: true })
    }
    catch {
        // Preserve original save failure; cleanup cannot make its write safe again.
    }
}

function throwFileSystemError(action: string, error: unknown): never {
    throw asLocalMemoryError(action, error)
}

function asLocalMemoryError(action: string, error: unknown): LocalMemoryError {
    if (error instanceof LocalMemoryError) return error
    return new LocalMemoryError("FILESYSTEM", `${action}: ${flattenError(error)}`)
}

function isMissingFile(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry: unknown): boolean => typeof entry === "string")
}

function hasOnlyMemoryMetadataKeys(value: Record<string, unknown>): boolean {
    const allowed = new Set(["timestamp", "id", "aliases", "context"])
    return Object.keys(value).every((key: string): boolean => allowed.has(key))
}

function escapeXml(value: string): string {
    return value.replace(/[&<>'"]/gu, (character: string): string => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", "\"": "&quot;" })[character] ?? character)
}

function unescapeXml(value: string): string {
    const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", apos: "'", quot: "\"" }
    return value.replace(/&(amp|lt|gt|apos|quot);/gu, (matched: string, entity: string): string => entities[entity] ?? matched)
}

function parseXmlAttributes(input: string): Record<string, string> | undefined {
    const attributes: Record<string, string> = {}
    const pattern = /\s+([A-Za-z_:][A-Za-z0-9_:.\-]*)="([^"]*)"/gu
    let consumed = ""
    for (const match of input.matchAll(pattern)) {
        if (attributes[match[1]] !== undefined) return undefined
        attributes[match[1]] = match[2]
        consumed += match[0]
    }
    return consumed === input ? attributes : undefined
}
