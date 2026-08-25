import type { Event, OpencodeClient } from "@opencode-ai/sdk"

const ALLOWED_AGENTS = new Set<string>(["advise", "assist", "auto"])
const FENCE_OPENING = /^\s*(`{3,}|~{3,})/
const COMPACT_HEADING = /^(\S+)\s+(.+)$/u
const HEADING_LINE = /^#\s+(\S+)\s+(.+)$/u
const EMOJI_TOKEN = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|(?:\p{Extended_Pictographic}|\p{Emoji_Modifier_Base})(?:\uFE0E|\uFE0F)?\p{Emoji_Modifier}?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Modifier_Base})(?:\uFE0E|\uFE0F)?\p{Emoji_Modifier}?)*)$/u

export type RootSessionTitleClient = Pick<OpencodeClient, "session">

export type RootSessionTitleHook = {
    handleEvent(event: Event): Promise<void>
}

type ProgressTurn = {
    sessionID: string
    messageID: string
    eventHasToolCallProgress: boolean
}

type RootSession = {
    id: string
    title: string
}

function getRecord(value: unknown, property: string): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || !(property in value)) return undefined
    const candidate = (value as Record<string, unknown>)[property]
    return typeof candidate === "object" && candidate !== null ? candidate as Record<string, unknown> : undefined
}

function getRecordString(value: unknown, property: string): string | undefined {
    if (typeof value !== "object" || value === null || !(property in value)) return undefined
    const candidate = (value as Record<string, unknown>)[property]
    return typeof candidate === "string" ? candidate : undefined
}

function getValidRecordString(value: unknown, property: string): string | undefined {
    const candidate = getRecordString(value, property)
    return candidate?.trim() ? candidate : undefined
}

function getRecordNumber(value: unknown, property: string): number | undefined {
    if (typeof value !== "object" || value === null || !(property in value)) return undefined
    const candidate = (value as Record<string, unknown>)[property]
    return typeof candidate === "number" ? candidate : undefined
}

function isAllowedAgent(agent: unknown): agent is string {
    return typeof agent === "string" && ALLOWED_AGENTS.has(agent)
}

function getMatchingSessionID(primary: unknown, secondary: unknown): string | undefined {
    const primaryID = typeof primary === "string" && primary.trim() ? primary : undefined
    const secondaryID = typeof secondary === "string" && secondary.trim() ? secondary : undefined
    if (primaryID !== undefined && secondaryID !== undefined && primaryID !== secondaryID) return undefined
    return primaryID ?? secondaryID
}

function hasToolCallFinish(value: unknown): boolean {
    return getRecordString(value, "finish") === "tool-calls"
}

function getAssistantProgressTurn(event: unknown): ProgressTurn | undefined {
    if (getRecordString(event, "type") !== "message.updated") return undefined
    const properties = getRecord(event, "properties")
    const info = getRecord(properties, "info")
    const completed = getRecordNumber(getRecord(info, "time"), "completed")
    const sessionID = getMatchingSessionID(getRecordString(properties, "sessionID"), getRecordString(info, "sessionID"))
    const messageID = getValidRecordString(info, "id")
    if (getRecordString(info, "role") !== "assistant" || !isAllowedAgent(getRecordString(info, "agent"))) return undefined
    if (completed === undefined || !Number.isFinite(completed) || sessionID === undefined || messageID === undefined) return undefined
    return {
        sessionID,
        messageID,
        eventHasToolCallProgress: hasToolCallFinish(info) || hasToolCallFinish(properties),
    }
}

function getPartProgressTurn(event: unknown): ProgressTurn | undefined {
    if (getRecordString(event, "type") !== "message.part.updated") return undefined
    const properties = getRecord(event, "properties")
    const part = getRecord(properties, "part")
    const partType = getRecordString(part, "type")
    const isToolPart = partType === "tool"
    const isToolCallFinish = partType === "step-finish" && getRecordString(part, "reason") === "tool-calls"
    if (!isToolPart && !isToolCallFinish) return undefined
    const sessionID = getMatchingSessionID(getRecordString(properties, "sessionID"), getRecordString(part, "sessionID"))
    const messageID = getValidRecordString(part, "messageID")
    if (sessionID === undefined || messageID === undefined) return undefined
    return { sessionID, messageID, eventHasToolCallProgress: true }
}

function getStepEndedProgressTurn(event: unknown): ProgressTurn | undefined {
    if (getRecordString(event, "type") !== "session.next.step.ended") return undefined
    for (const value of [getRecord(event, "data"), getRecord(event, "properties")]) {
        if (!hasToolCallFinish(value)) continue
        const sessionID = getValidRecordString(value, "sessionID")
        const messageID = getValidRecordString(value, "assistantMessageID") ?? getValidRecordString(value, "messageID")
        if (sessionID !== undefined && messageID !== undefined) return { sessionID, messageID, eventHasToolCallProgress: true }
    }
    return undefined
}

function getProgressTurn(event: unknown): ProgressTurn | undefined {
    return getAssistantProgressTurn(event) ?? getPartProgressTurn(event) ?? getStepEndedProgressTurn(event)
}

function isFenceClosing(line: string, fence: string): boolean {
    const marker = fence[0]
    const closing = new RegExp(`^\\s*${marker}{${fence.length},}\\s*$`)
    return closing.test(line)
}

function isEmojiToken(value: string): boolean {
    return EMOJI_TOKEN.test(value)
}

function parseCompactHeading(value: string): string | undefined {
    const match = COMPACT_HEADING.exec(value.trim())
    if (match === null) return undefined
    const emoji = match[1]
    const title = match[2].trim()
    if (!isEmojiToken(emoji) || !title) return undefined
    return `${emoji} ${title}`
}

export function parseRootSessionTitleHeading(text: string): string | undefined {
    let fence: string | undefined
    for (const line of text.split(/\r?\n/u)) {
        if (fence !== undefined) {
            if (isFenceClosing(line, fence)) fence = undefined
            continue
        }

        const opening = FENCE_OPENING.exec(line)
        if (opening !== null) {
            fence = opening[1]
            continue
        }
        if (!line.trim()) continue

        const match = HEADING_LINE.exec(line.trim())
        if (match === null) return undefined
        const emoji = match[1]
        const title = match[2].trim()
        if (!isEmojiToken(emoji) || !title) return undefined
        return `${emoji} ${title}`
    }
    return undefined
}

function findFinalParenthesizedSuffix(title: string): number | undefined {
    if (!title.endsWith(")")) return undefined
    let depth = 0
    for (let index = title.length - 1; index >= 0; index -= 1) {
        const character = title[index]
        if (character === ")") depth += 1
        if (character !== "(") continue
        depth -= 1
        if (depth === 0) return index
    }
    return undefined
}

export function reconcileRootSessionTitle(currentTitle: string, heading: string): string {
    const compactHeading = parseCompactHeading(heading)
    if (compactHeading === undefined || !currentTitle.trim()) return currentTitle

    const suffixStart = findFinalParenthesizedSuffix(currentTitle)
    if (suffixStart === undefined || suffixStart === 0 || currentTitle[suffixStart - 1] !== " ") {
        return `${currentTitle} (${compactHeading})`
    }

    return `${currentTitle.slice(0, suffixStart - 1)} (${compactHeading})`
}

function hasFetchedToolCallProgress(parts: unknown[]): boolean {
    return parts.some((part: unknown): boolean => {
        const type = getRecordString(part, "type")
        return type === "tool" || (type === "step-finish" && getRecordString(part, "reason") === "tool-calls")
    })
}

function extractTextParts(parts: unknown[]): string {
    return parts
        .filter((part: unknown): boolean => getRecordString(part, "type") === "text")
        .map((part: unknown): string => getRecordString(part, "text") ?? "")
        .join("")
}

async function resolveRootSession(
    client: RootSessionTitleClient,
    directory: string,
    initialSessionID: string,
): Promise<RootSession | undefined> {
    const visited = new Set<string>()
    let sessionID = initialSessionID
    while (!visited.has(sessionID)) {
        visited.add(sessionID)
        const response = await client.session.get({ path: { id: sessionID }, query: { directory } })
        if (response.error !== undefined || response.data === undefined) return undefined

        const id = getValidRecordString(response.data, "id")
        const title = getRecordString(response.data, "title")
        const parentID = getRecordString(response.data, "parentID")
        if (id === undefined || id !== sessionID || title === undefined) return undefined
        if (parentID === undefined) return { id, title }
        if (!parentID.trim()) return undefined
        sessionID = parentID
    }
    return undefined
}

async function processProgressTurn(
    client: RootSessionTitleClient,
    directory: string,
    turn: ProgressTurn,
): Promise<void> {
    const messagesResponse = await client.session.messages({ path: { id: turn.sessionID }, query: { directory } })
    if (messagesResponse.error !== undefined || messagesResponse.data === undefined) return

    const target = messagesResponse.data.find((message): boolean => message.info.id === turn.messageID)
    if (target === undefined || !Array.isArray(target.parts)) return
    if (target.info.role !== "assistant" || !isAllowedAgent(getRecordString(target.info, "agent"))) return
    if (!turn.eventHasToolCallProgress && !hasFetchedToolCallProgress(target.parts)) return

    const heading = parseRootSessionTitleHeading(extractTextParts(target.parts))
    if (heading === undefined) return

    const root = await resolveRootSession(client, directory, turn.sessionID)
    if (root === undefined) return
    const title = reconcileRootSessionTitle(root.title, heading)
    if (title === root.title) return

    await client.session.update({
        path: { id: root.id },
        query: { directory },
        body: { title },
    })
}

export async function handleRootSessionTitleEvent(
    client: RootSessionTitleClient,
    directory: string,
    event: Event,
): Promise<void> {
    try {
        const turn = getProgressTurn(event)
        if (turn === undefined) return
        await processProgressTurn(client, directory, turn)
    }
    catch {
        // Title updates are advisory and must not interrupt event delivery.
    }
}

export function createRootSessionTitleHook(client: RootSessionTitleClient, directory: string): RootSessionTitleHook {
    return {
        async handleEvent(event: Event): Promise<void> {
            await handleRootSessionTitleEvent(client, directory, event)
        },
    }
}
