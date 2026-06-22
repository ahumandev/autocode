import { tool, type ToolContext } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createAbortResponse } from "@/utils/tools"

type JsonObject = Record<string, unknown>

type TokenTotals = {
    input: number
    output: number
    reasoning: number
    cache: {
        read: number
        write: number
    }
}

type ContextTotals = {
    message_cost: number
    message_tokens: TokenTotals
    step_finish_cost: number
    step_finish_tokens: TokenTotals
    message_count: number
    user_message_count: number
    assistant_message_count: number
    step_finish_part_count: number
}

function isRecord(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getRecord(value: JsonObject, key: string): JsonObject | undefined {
    const item = value[key]

    return isRecord(item) ? item : undefined
}

function getString(value: JsonObject, key: string): string | undefined {
    const item = value[key]

    return typeof item === "string" ? item : undefined
}

function getNumber(value: JsonObject, key: string): number | undefined {
    const item = value[key]

    return typeof item === "number" && Number.isFinite(item) ? item : undefined
}

function getSafeValue(value: JsonObject, key: string): unknown {
    const item = value[key]

    return item === null || ["string", "number", "boolean"].includes(typeof item) || isRecord(item) ? item : undefined
}

function createTokenTotals(): TokenTotals {
    return {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
            read: 0,
            write: 0,
        },
    }
}

function addTokens(total: TokenTotals, tokens: unknown): void {
    if (!isRecord(tokens)) {
        return
    }

    total.input += getNumber(tokens, "input") ?? 0
    total.output += getNumber(tokens, "output") ?? 0
    total.reasoning += getNumber(tokens, "reasoning") ?? 0

    const cache = getRecord(tokens, "cache")
    total.cache.read += cache ? getNumber(cache, "read") ?? 0 : 0
    total.cache.write += cache ? getNumber(cache, "write") ?? 0 : 0
}

function sanitizeTokens(tokens: unknown): JsonObject | undefined {
    if (!isRecord(tokens)) {
        return undefined
    }

    const sanitized: JsonObject = {}
    for (const key of ["input", "output", "reasoning"]) {
        const value = getNumber(tokens, key)
        if (value !== undefined) {
            sanitized[key] = value
        }
    }

    const cache = getRecord(tokens, "cache")
    if (cache) {
        const sanitizedCache: JsonObject = {}
        const read = getNumber(cache, "read")
        const write = getNumber(cache, "write")
        if (read !== undefined) {
            sanitizedCache.read = read
        }
        if (write !== undefined) {
            sanitizedCache.write = write
        }
        sanitized.cache = sanitizedCache
    }

    return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

function getModelFields(model: unknown): JsonObject | undefined {
    if (!isRecord(model)) {
        return undefined
    }

    const providerID = getString(model, "providerID") ?? getString(model, "provider_id")
    const modelID = getString(model, "modelID") ?? getString(model, "model_id")
    if (!providerID && !modelID) {
        return undefined
    }

    return {
        provider_id: providerID,
        model_id: modelID,
    }
}

function sanitizeSession(session: unknown): JsonObject {
    if (!isRecord(session)) {
        return {}
    }

    const sanitized: JsonObject = {}
    for (const [sourceKey, targetKey] of [
        ["id", "id"],
        ["projectID", "project_id"],
        ["project_id", "project_id"],
        ["directory", "directory"],
        ["parentID", "parent_id"],
        ["parent_id", "parent_id"],
        ["title", "title"],
        ["version", "version"],
        ["time", "time"],
    ]) {
        const value = getSafeValue(session, sourceKey)
        if (value !== undefined) {
            sanitized[targetKey] = value
        }
    }

    const summary = getRecord(session, "summary") ?? session
    const summaryCounts = {
        additions: getNumber(summary, "additions"),
        deletions: getNumber(summary, "deletions"),
        files: getNumber(summary, "files"),
    }
    if (summaryCounts.additions !== undefined || summaryCounts.deletions !== undefined || summaryCounts.files !== undefined) {
        sanitized.summary = summaryCounts
    }

    return sanitized
}

function sanitizeUserMessage(info: JsonObject): JsonObject {
    const sanitized: JsonObject = {
        id: getString(info, "id"),
        role: "user",
        time: getSafeValue(info, "time"),
        agent: getString(info, "agent"),
    }
    const model = getModelFields(info.model)
    if (model) {
        sanitized.model = model
    }

    return sanitized
}

function sanitizeAssistantMessage(info: JsonObject, totals: ContextTotals): JsonObject {
    totals.assistant_message_count += 1
    totals.message_cost += getNumber(info, "cost") ?? 0
    addTokens(totals.message_tokens, info.tokens)

    return {
        id: getString(info, "id"),
        role: "assistant",
        time: getSafeValue(info, "time"),
        parent_id: getString(info, "parentID") ?? getString(info, "parent_id"),
        provider_id: getString(info, "providerID") ?? getString(info, "provider_id"),
        model_id: getString(info, "modelID") ?? getString(info, "model_id"),
        mode: getString(info, "mode"),
        cost: getNumber(info, "cost"),
        tokens: sanitizeTokens(info.tokens),
        finish: getSafeValue(info, "finish"),
    }
}

function sanitizeStepFinishPart(part: JsonObject, fallbackMessageID: string | undefined, totals: ContextTotals): JsonObject | undefined {
    if (getString(part, "type") !== "step-finish") {
        return undefined
    }

    totals.step_finish_part_count += 1
    totals.step_finish_cost += getNumber(part, "cost") ?? 0
    addTokens(totals.step_finish_tokens, part.tokens)

    return {
        message_id: getString(part, "messageID") ?? getString(part, "message_id") ?? fallbackMessageID,
        part_id: getString(part, "id") ?? getString(part, "partID") ?? getString(part, "part_id"),
        cost: getNumber(part, "cost"),
        tokens: sanitizeTokens(part.tokens),
        reason: getString(part, "reason"),
        finish: getSafeValue(part, "finish"),
    }
}

function sanitizeMessages(messages: unknown, totals: ContextTotals): { messages: JsonObject[], step_finish_parts: JsonObject[] } {
    const sanitizedMessages: JsonObject[] = []
    const stepFinishParts: JsonObject[] = []
    if (!Array.isArray(messages)) {
        return { messages: sanitizedMessages, step_finish_parts: stepFinishParts }
    }

    for (const message of messages) {
        if (!isRecord(message) || !isRecord(message.info)) {
            continue
        }

        const role = getString(message.info, "role")
        totals.message_count += 1
        if (role === "user") {
            totals.user_message_count += 1
            sanitizedMessages.push(sanitizeUserMessage(message.info))
        }
        else if (role === "assistant") {
            sanitizedMessages.push(sanitizeAssistantMessage(message.info, totals))
        }

        const fallbackMessageID = getString(message.info, "id")
        const parts = Array.isArray(message.parts) ? message.parts : []
        for (const part of parts) {
            if (!isRecord(part)) {
                continue
            }

            const sanitizedPart = sanitizeStepFinishPart(part, fallbackMessageID, totals)
            if (sanitizedPart) {
                stepFinishParts.push(sanitizedPart)
            }
        }
    }

    return { messages: sanitizedMessages, step_finish_parts: stepFinishParts }
}

function createTotals(): ContextTotals {
    return {
        message_cost: 0,
        message_tokens: createTokenTotals(),
        step_finish_cost: 0,
        step_finish_tokens: createTokenTotals(),
        message_count: 0,
        user_message_count: 0,
        assistant_message_count: 0,
        step_finish_part_count: 0,
    }
}

export function createAutocodeSessionContextTool(client?: OpencodeClient): ReturnType<typeof tool> {
    return tool({
        description: "Read sanitized current session context and token usage metadata.",
        args: {},
        async execute(_args: Record<string, never>, context: ToolContext): Promise<string> {
            const toolContext = context as ToolContext & { agent?: string }
            if (!client) {
                return createAbortResponse("autocode_session_context", "Unable to inspect current session: client is unavailable")
            }

            if (!toolContext.sessionID) {
                return createAbortResponse("autocode_session_context", "Unable to inspect current session: session id is unavailable")
            }

            try {
                const sessionResponse = await client.session.get({
                    path: { id: toolContext.sessionID },
                    query: { directory: toolContext.directory },
                })
                if (sessionResponse.error || !sessionResponse.data) {
                    return createAbortResponse("autocode_session_context", sessionResponse.error ?? `Current session unavailable: ${toolContext.sessionID}`)
                }

                const messagesResponse = await client.session.messages({
                    path: { id: toolContext.sessionID },
                    query: { directory: toolContext.directory },
                })
                if (messagesResponse.error || !messagesResponse.data) {
                    return createAbortResponse("autocode_session_context", messagesResponse.error ?? `Current session messages unavailable: ${toolContext.sessionID}`)
                }

                const totals = createTotals()
                const sanitized = sanitizeMessages(messagesResponse.data, totals)

                return JSON.stringify({
                    tool_context: {
                        session_id: toolContext.sessionID,
                        message_id: toolContext.messageID,
                        agent: toolContext.agent,
                        directory: toolContext.directory,
                        worktree: toolContext.worktree,
                    },
                    session: sanitizeSession(sessionResponse.data),
                    messages: sanitized.messages,
                    step_finish_parts: sanitized.step_finish_parts,
                    totals,
                })
            }
            catch (error) {
                return createAbortResponse("autocode_session_context", error)
            }
        },
    })
}
