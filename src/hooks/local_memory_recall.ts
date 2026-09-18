import { randomUUID } from "node:crypto"
import type { Part, TextPart } from "@opencode-ai/sdk"
import type { Hooks } from "@opencode-ai/plugin"
import {
    isTrustedLocalMemoryXmlBlock,
    normalizeLocalMemoryMatchValue,
    parseTrustedLocalMemoryXmlBlocks,
    selectLocalMemories,
    type LocalMemoryFileSystem,
    type TrustedLocalMemoryXmlBlock,
} from "@/utils/local_memory"
import type { SessionJobContext } from "@/utils/jobs"

const localMemoryPartMetadataKey = "autocode.local_memory"
const localMemoryPartMetadataVersion = "v1"
const localMemoryPreparationMetadataKey = "autocode.local_memory_prepared"

type ChatMessageHook = NonNullable<Hooks["chat.message"]>
type ChatMessagesTransformHook = NonNullable<Hooks["experimental.chat.messages.transform"]>
type EventHook = NonNullable<Hooks["event"]>
export type LocalMemorySessionMessage = {
    info: { id: string }
    parts: Part[]
}

export type LocalMemoryRecallChatMessageInput = Parameters<ChatMessageHook>[0]
export type LocalMemoryRecallChatMessageOutput = Parameters<ChatMessageHook>[1]
export type LocalMemorySessionContextLoader = (sessionID: string) => Promise<readonly LocalMemorySessionMessage[] | undefined>
export type LocalMemoryRecallDiagnostic = {
    reason: "session_context_unavailable" | "selection_failed"
    sessionID?: string
    messageID?: string
}
export type LocalMemoryRecallDependencies = {
    context: Pick<SessionJobContext, "directory" | "worktree">
    fileSystem: LocalMemoryFileSystem
    loadSessionContext: LocalMemorySessionContextLoader
    isSmartAgent(agentName: string): boolean
    diagnose?: (diagnostic: LocalMemoryRecallDiagnostic) => void
}
type LocalMemoryPreparation = {
    text: string
}
export type LocalMemorySessionMessagesClient = {
    session: {
        messages?: (request: { path: { id: string }, query: { directory: string } }) => Promise<unknown>
    }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function getRecordString(value: unknown, property: string): string | undefined {
    const record = getRecord(value)
    const candidate = record?.[property]
    return typeof candidate === "string" && candidate.trim() ? candidate : undefined
}

function getSessionMessages(value: unknown): LocalMemorySessionMessage[] | undefined {
    const response = getRecord(value)
    if (response?.error !== undefined || !Array.isArray(response?.data)) return undefined
    const messages: LocalMemorySessionMessage[] = []
    for (const candidate of response.data) {
        const info = getRecord(candidate)?.info
        const parts = getRecord(candidate)?.parts
        const id = getRecordString(info, "id")
        if (id === undefined || !Array.isArray(parts)) return undefined
        messages.push({ info: { id }, parts: parts as Part[] })
    }
    return messages
}

function getTrustedMarkedBlocks(part: Part): TrustedLocalMemoryXmlBlock[] | undefined {
    if (part.type !== "text" || !isPluginOwnedLocalMemoryPart(part)) return undefined
    const blocks = parseTrustedLocalMemoryXmlBlocks(part.text)
    if (blocks.length === 1 && !isTrustedLocalMemoryXmlBlock(part.text)) return undefined
    if (blocks.length === 0 || blocks.map((block: TrustedLocalMemoryXmlBlock): string => block.xml).join("\n") !== part.text) return undefined
    return blocks
}

function isPluginOwnedLocalMemoryPart(part: TextPart): boolean {
    const metadata = getRecord(part.metadata)
    return metadata?.[localMemoryPartMetadataKey] === localMemoryPartMetadataVersion
}

function isLocalMemoryPreparationMarker(part: Part): boolean {
    if (part.type !== "text" || part.text !== "" || !isPluginOwnedLocalMemoryPart(part)) return false
    const metadata = getRecord(part.metadata)
    return metadata?.[localMemoryPreparationMetadataKey] === localMemoryPartMetadataVersion
}

function getLoadedMemoryIDs(messages: readonly LocalMemorySessionMessage[]): string[] {
    const loadedIDs = new Set<string>()
    for (const message of messages) {
        for (const part of message.parts) {
            const blocks = getTrustedMarkedBlocks(part)
            if (blocks === undefined) continue
            for (const block of blocks) {
                const id = normalizeLocalMemoryMatchValue(block.id_keyword)
                if (id) loadedIDs.add(id)
            }
        }
    }
    return [...loadedIDs]
}

function hasPreparedLocalMemoryPart(parts: readonly Part[]): boolean {
    return parts.some((part: Part): boolean => getTrustedMarkedBlocks(part) !== undefined || isLocalMemoryPreparationMarker(part))
}

function getCurrentPrompt(parts: readonly Part[]): string {
    return parts
        .filter((part: Part): part is TextPart => part.type === "text" && getTrustedMarkedBlocks(part) === undefined && !isLocalMemoryPreparationMarker(part))
        .map((part: TextPart): string => part.text)
        .join("\n")
}

function getEligibleAgentName(output: LocalMemoryRecallChatMessageOutput, isSmartAgent: (agentName: string) => boolean): string | undefined {
    if (output.message.role !== "user" || !output.parts.some((part: Part): boolean => part.type === "text" && part.text.trim().length > 0)) return undefined
    const agentName = output.message.agent
    return typeof agentName === "string" && isSmartAgent(agentName) ? agentName : undefined
}

function createLocalMemoryTextPart(input: LocalMemoryRecallChatMessageInput, output: LocalMemoryRecallChatMessageOutput, text: string): TextPart {
    return {
        id: randomUUID(),
        sessionID: input.sessionID,
        messageID: output.message.id,
        type: "text",
        text,
        metadata: { [localMemoryPartMetadataKey]: localMemoryPartMetadataVersion },
    }
}

function createLocalMemoryPreparationMarker(input: LocalMemoryRecallChatMessageInput, output: LocalMemoryRecallChatMessageOutput): TextPart {
    return {
        id: randomUUID(),
        sessionID: input.sessionID,
        messageID: output.message.id,
        type: "text",
        text: "",
        metadata: {
            [localMemoryPartMetadataKey]: localMemoryPartMetadataVersion,
            [localMemoryPreparationMetadataKey]: localMemoryPartMetadataVersion,
        },
    }
}

function containsPreparedPartForMessage(messages: readonly LocalMemorySessionMessage[], messageID: string): boolean {
    return messages.some((message: LocalMemorySessionMessage): boolean => message.info.id === messageID && hasPreparedLocalMemoryPart(message.parts))
}

function reportDiagnostic(diagnose: (diagnostic: LocalMemoryRecallDiagnostic) => void, reason: LocalMemoryRecallDiagnostic["reason"], input: LocalMemoryRecallChatMessageInput, output: LocalMemoryRecallChatMessageOutput): void {
    diagnose({ reason, sessionID: input.sessionID, messageID: output.message.id })
}

function defaultDiagnose(diagnostic: LocalMemoryRecallDiagnostic): void {
    const identifiers = [diagnostic.sessionID ? `session=${diagnostic.sessionID}` : "", diagnostic.messageID ? `message=${diagnostic.messageID}` : ""].filter(Boolean).join(" ")
    console.warn(`autocode: local memory recall skipped: ${diagnostic.reason}${identifiers ? ` ${identifiers}` : ""}`)
}

function dedupePreparedParts(parts: Part[], seenIDs: Set<string>): void {
    const retained: Part[] = []
    for (const part of parts) {
        if (isLocalMemoryPreparationMarker(part)) {
            retained.push(part)
            continue
        }
        const blocks = getTrustedMarkedBlocks(part)
        if (blocks === undefined) {
            retained.push(part)
            continue
        }
        const uniqueBlocks = blocks.filter((block: TrustedLocalMemoryXmlBlock): boolean => {
            const normalizedID = normalizeLocalMemoryMatchValue(block.id_keyword)
            if (!normalizedID || seenIDs.has(normalizedID)) return false
            seenIDs.add(normalizedID)
            return true
        })
        if (uniqueBlocks.length === 0) continue
        if (uniqueBlocks.length === blocks.length) {
            retained.push(part)
            continue
        }
        if (part.type !== "text") {
            retained.push(part)
            continue
        }
        retained.push({ ...part, text: uniqueBlocks.map((block: TrustedLocalMemoryXmlBlock): string => block.xml).join("\n") })
    }
    parts.splice(0, parts.length, ...retained)
}

export function createOpenCodeLocalMemorySessionContextLoader(client: LocalMemorySessionMessagesClient, directory: string): LocalMemorySessionContextLoader {
    return async (sessionID: string): Promise<readonly LocalMemorySessionMessage[] | undefined> => {
        if (client.session.messages === undefined) return undefined
        try {
            return getSessionMessages(await client.session.messages({ path: { id: sessionID }, query: { directory } }))
        }
        catch {
            return undefined
        }
    }
}

function getDeletedSessionID(event: Parameters<EventHook>[0]["event"]): string | undefined {
    if (event.type !== "session.deleted") return undefined
    return getRecordString(event.properties, "sessionID") ?? getRecordString(getRecord(event.properties)?.info, "id")
}

export function createLocalMemoryRecallHook(dependencies: LocalMemoryRecallDependencies): Pick<Hooks, "chat.message" | "event" | "dispose" | "experimental.chat.messages.transform"> {
    const diagnose = dependencies.diagnose ?? defaultDiagnose
    const claimedAgentsBySession = new Map<string, Set<string>>()

    async function prepareLocalMemory(input: LocalMemoryRecallChatMessageInput, output: LocalMemoryRecallChatMessageOutput, prompt: string): Promise<LocalMemoryPreparation | undefined> {
        try {
            const messages = await dependencies.loadSessionContext(input.sessionID)
            if (messages === undefined) {
                reportDiagnostic(diagnose, "session_context_unavailable", input, output)
                return undefined
            }
            if (containsPreparedPartForMessage(messages, output.message.id)) return undefined

            const selected = await selectLocalMemories(dependencies.fileSystem, dependencies.context, {
                prompt,
                loaded_ids: getLoadedMemoryIDs(messages),
            })
            return { text: selected.xml }
        }
        catch {
            reportDiagnostic(diagnose, "selection_failed", input, output)
            return undefined
        }
    }

    return {
        async "chat.message"(input: LocalMemoryRecallChatMessageInput, output: LocalMemoryRecallChatMessageOutput): Promise<void> {
            const agentName = getEligibleAgentName(output, dependencies.isSmartAgent)
            if (agentName === undefined) return
            const claimedAgents = claimedAgentsBySession.get(input.sessionID) ?? new Set<string>()
            if (claimedAgents.has(agentName)) return
            claimedAgents.add(agentName)
            claimedAgentsBySession.set(input.sessionID, claimedAgents)
            if (hasPreparedLocalMemoryPart(output.parts)) return

            const preparation = await prepareLocalMemory(input, output, getCurrentPrompt(output.parts))
            if (preparation === undefined) return
            if (preparation.text) output.parts.push(createLocalMemoryTextPart(input, output, preparation.text))
            else output.parts.push(createLocalMemoryPreparationMarker(input, output))
        },
        async event({ event }: Parameters<EventHook>[0]): Promise<void> {
            const sessionID = getDeletedSessionID(event)
            if (sessionID !== undefined) claimedAgentsBySession.delete(sessionID)
        },
        async dispose(): Promise<void> {
            claimedAgentsBySession.clear()
        },
        async "experimental.chat.messages.transform"(_input: Parameters<ChatMessagesTransformHook>[0], output: Parameters<ChatMessagesTransformHook>[1]): Promise<void> {
            const seenIDs = new Set<string>()
            for (const message of output.messages) {
                dedupePreparedParts(message.parts, seenIDs)
            }
        },
    }
}
