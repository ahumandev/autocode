import type { Event, OpencodeClient } from "@opencode-ai/sdk"
import { dispatchAutocodeAgentPrompt, type PrimaryAutocodeAgent, type ResolvedAgentModel } from "@/utils/agent_swap"
import { formatSessionTitleWithStatus } from "@/utils/session_title"
import { flattenError } from "@/utils/tools"

export const DEFAULT_AGENT_HANDOFF_TIMEOUT_MS = 5 * 60 * 1000

export type PendingRestartCompactionResponse = {
    data?: boolean
    error?: unknown
}

export type PendingAgentRestart = {
    client: Pick<OpencodeClient, "session">
    directory: string
    sessionID: string
    currentAgent: PrimaryAutocodeAgent
    targetAgent: PrimaryAutocodeAgent
    prompt: string
    resolvedModel: ResolvedAgentModel
    summarize: () => Promise<PendingRestartCompactionResponse>
    abort?: AbortSignal
}

export type PendingAgentRestartRegistration = "registered" | "duplicate" | "aborted"

export type PendingAgentHandoffLifecycleFailure = {
    stage: "rename" | "prompt"
    error: string
    instruction: string
    source: {
        sessionID: string
        title: string
        messageID: string
    }
    destination: {
        sessionID: string
        title: string
    }
}

export type PendingAgentHandoff = {
    client: Pick<OpencodeClient, "session">
    directory: string
    source: {
        sessionID: string
        title: string
        messageID: string
    }
    destination: {
        sessionID: string
        title: string
        agent: PrimaryAutocodeAgent
        prompt: string
        resolvedModel: ResolvedAgentModel
    }
    abort?: AbortSignal
    reportLifecycleFailure: (failure: PendingAgentHandoffLifecycleFailure) => void | Promise<void>
}

export type PendingAgentHandoffRegistration =
    | { status: "registered", sourceSessionID: string, destinationSessionID: string }
    | { status: "duplicate" | "aborted" | "invalid", error: string, instruction: string }

export type PendingAgentRestartCoordinator = {
    register(restart: PendingAgentRestart): PendingAgentRestartRegistration
    registerHandoff(handoff: PendingAgentHandoff): PendingAgentHandoffRegistration
    handleEvent(event: Event): Promise<void>
    dispose(): void
    pendingCount(): number
}

type PendingAgentRestartEntry = PendingAgentRestart & {
    key: string
    timer?: ReturnType<typeof setTimeout>
    abortListener?: () => void
    running: boolean
    cancelled: boolean
}

type PendingAgentHandoffEntry = PendingAgentHandoff & {
    key: string
    timer?: ReturnType<typeof setTimeout>
    abortListener?: () => void
    running: boolean
    cancelled: boolean
}

type PendingAgentEntry = PendingAgentRestartEntry | PendingAgentHandoffEntry

type HandoffTurn = {
    sessionID: string
    messageID: string
}

function createRestartKey(directory: string, sessionID: string): string {
    return `${directory}\u0000${sessionID}`
}

function getSessionID(event: Event): string | undefined {
    if (event.type === "session.deleted") return event.properties.info.id
    if (event.type === "session.error") return event.properties.sessionID
    if (event.type === "session.status" || event.type === "session.idle") return event.properties.sessionID
    if (event.type === "message.updated") return getCompletedAssistantMessageSessionID(event)
    if (getRecordString(event, "type") === "message.part.updated") return getTerminalMessagePartSessionID(event)
    return getTerminalStepEndedSessionID(event)
}

function getCompletedAssistantMessageSessionID(event: Event): string | undefined {
    if (event.type !== "message.updated") return undefined
    const info = getRecord(event.properties, "info")
    if (getRecordString(info, "role") !== "assistant") return undefined
    if (hasToolCallMessageFinish(event, info)) return undefined
    const completed = getRecordNumber(getRecord(info, "time"), "completed")
    if (completed === undefined || !Number.isFinite(completed)) return undefined
    return getRecordString(info, "sessionID")
}

function getTerminalMessagePartSessionID(event: Event): string | undefined {
    if (getRecordString(event, "type") !== "message.part.updated") return undefined
    const properties = getRecord(event, "properties")
    const sessionID = getValidRecordString(properties, "sessionID")
    const part = getRecord(properties, "part")
    if (sessionID === undefined || part === undefined) return undefined
    if (getRecordString(part, "type") !== "step-finish" || getRecordString(part, "reason") !== "stop") return undefined
    if ("sessionID" in part && getRecordString(part, "sessionID") !== sessionID) return undefined
    return sessionID
}

function getTerminalStepEndedSessionID(event: Event): string | undefined {
    if (getRecordString(event, "type") !== "session.next.step.ended") return undefined
    for (const step of [getRecord(event, "data"), getRecord(event, "properties")]) {
        if (getRecordString(step, "finish") !== "stop") continue
        const sessionID = getRecordString(step, "sessionID")
        if (sessionID !== undefined) return sessionID
    }
    return undefined
}

function getCompletedAssistantMessageTurn(event: Event): HandoffTurn | undefined {
    if (event.type !== "message.updated") return undefined
    const info = getRecord(event.properties, "info")
    if (getRecordString(info, "role") !== "assistant") return undefined
    if (hasToolCallMessageFinish(event, info)) return undefined
    if (getRecordString(info, "finish") === "stop") return undefined
    const completed = getRecordNumber(getRecord(info, "time"), "completed")
    const sessionID = getValidRecordString(info, "sessionID")
    const messageID = getValidRecordString(info, "id")
    if (completed === undefined || !Number.isFinite(completed) || sessionID === undefined || messageID === undefined) return undefined
    return { sessionID, messageID }
}

function getTerminalMessagePartTurn(event: Event): HandoffTurn | undefined {
    if (getRecordString(event, "type") !== "message.part.updated") return undefined
    const properties = getRecord(event, "properties")
    const sessionID = getValidRecordString(properties, "sessionID")
    const part = getRecord(properties, "part")
    const messageID = getValidRecordString(part, "messageID")
    if (sessionID === undefined || part === undefined || messageID === undefined) return undefined
    if (getRecordString(part, "type") !== "step-finish" || getRecordString(part, "reason") !== "stop") return undefined
    if ("sessionID" in part && getRecordString(part, "sessionID") !== sessionID) return undefined
    return { sessionID, messageID }
}

function getToolCallsStepFinish(event: Event): HandoffTurn | undefined {
    if (getRecordString(event, "type") !== "message.part.updated") return undefined
    const properties = getRecord(event, "properties")
    const sessionID = getValidRecordString(properties, "sessionID")
    const part = getRecord(properties, "part")
    const messageID = getValidRecordString(part, "messageID")
    if (sessionID === undefined || part === undefined || messageID === undefined) return undefined
    if (getRecordString(part, "type") !== "step-finish" || getRecordString(part, "reason") !== "tool-calls") return undefined
    if ("sessionID" in part && getRecordString(part, "sessionID") !== sessionID) return undefined
    return { sessionID, messageID }
}

function getTerminalStepEndedTurn(event: Event): HandoffTurn | undefined {
    if (getRecordString(event, "type") !== "session.next.step.ended") return undefined
    for (const step of [getRecord(event, "data"), getRecord(event, "properties")]) {
        if (getRecordString(step, "finish") !== "stop") continue
        const sessionID = getValidRecordString(step, "sessionID")
        const messageID = getValidRecordString(step, "messageID") ?? getValidRecordString(step, "assistantMessageID")
        if (sessionID !== undefined && messageID !== undefined) return { sessionID, messageID }
    }
    return undefined
}

function getHandoffTurn(event: Event): HandoffTurn | undefined {
    return getCompletedAssistantMessageTurn(event)
        ?? getTerminalMessagePartTurn(event)
        ?? getTerminalStepEndedTurn(event)
}

function hasToolCallMessageFinish(event: Event, info: Record<string, unknown> | undefined): boolean {
    return getRecordString(info, "finish") === "tool-calls"
        || getRecordString(event.properties, "finish") === "tool-calls"
}

function getRecord(value: unknown, property: string): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || !(property in value)) return undefined
    const candidate = (value as Record<string, unknown>)[property]
    return typeof candidate === "object" && candidate !== null ? candidate as Record<string, unknown> : undefined
}

function getRecordNumber(value: unknown, property: string): number | undefined {
    if (typeof value !== "object" || value === null || !(property in value)) return undefined
    const candidate = (value as Record<string, unknown>)[property]
    return typeof candidate === "number" ? candidate : undefined
}

function getValidRecordString(value: unknown, property: string): string | undefined {
    const candidate = getRecordString(value, property)
    return candidate?.trim() ? candidate : undefined
}

function isIdleEvent(event: Event): boolean {
    return (event.type === "session.status" && event.properties.status.type === "idle")
        || event.type === "session.idle"
        || getTerminalStepEndedSessionID(event) !== undefined
}

function isHandoffIdleEvent(event: Event): boolean {
    return (event.type === "session.status" && event.properties.status.type === "idle")
        || event.type === "session.idle"
}

function getRecordString(value: unknown, property: string): string | undefined {
    if (typeof value !== "object" || value === null || !(property in value)) return undefined
    const candidate = (value as Record<string, unknown>)[property]
    return typeof candidate === "string" ? candidate : undefined
}

function getEventDirectory(event: Event): string | undefined {
    return getRecordString(event.properties, "directory") ?? getRecordString(event, "directory")
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
    if (typeof timer !== "object" || timer === null || !("unref" in timer)) return
    const unref = timer.unref
    if (typeof unref === "function") unref.call(timer)
}

function isHandoffEntry(entry: PendingAgentEntry): entry is PendingAgentHandoffEntry {
    return "source" in entry
}

function getEntrySessionID(entry: PendingAgentEntry): string {
    return isHandoffEntry(entry) ? entry.source.sessionID : entry.sessionID
}

function padDateTimePart(value: number): string {
    return String(value).padStart(2, "0")
}

export function formatHandoffSourceTitle(title: string): string {
    const now = new Date()
    const timestamp = `${now.getFullYear()}-${padDateTimePart(now.getMonth() + 1)}-${padDateTimePart(now.getDate())} ${padDateTimePart(now.getHours())}:${padDateTimePart(now.getMinutes())}`
    return formatSessionTitleWithStatus(title, timestamp)
}

function normalizeError(error: unknown): string {
    try {
        return flattenError(error)
    }
    catch {
        return "Unknown error"
    }
}

export function createPendingAgentRestartCoordinator(
    timeoutMs?: number,
    handoffTimeoutMs: number = timeoutMs ?? DEFAULT_AGENT_HANDOFF_TIMEOUT_MS,
): PendingAgentRestartCoordinator {
    const pending = new Map<string, PendingAgentEntry>()

    function stopTimer(entry: PendingAgentEntry): void {
        if (entry.timer !== undefined) {
            clearTimeout(entry.timer)
            entry.timer = undefined
        }
    }

    function stopWaiting(entry: PendingAgentEntry): void {
        stopTimer(entry)
        if (entry.abort && entry.abortListener) {
            entry.abort.removeEventListener("abort", entry.abortListener)
        }
    }

    function clear(entry: PendingAgentEntry): void {
        if (pending.get(entry.key) !== entry) return
        pending.delete(entry.key)
        entry.cancelled = true
        stopWaiting(entry)
    }

    function clearSession(sessionID: string): void {
        for (const entry of pending.values()) {
            if (getEntrySessionID(entry) === sessionID) clear(entry)
        }
    }

    function consumeHandoff(entry: PendingAgentHandoffEntry): PendingAgentHandoffEntry {
        entry.running = true
        pending.delete(entry.key)
        stopWaiting(entry)
        return entry
    }

    function takeHandoffForTurn(turn: HandoffTurn, directory: string | undefined): PendingAgentHandoffEntry | undefined {
        let match: PendingAgentHandoffEntry | undefined
        for (const entry of pending.values()) {
            if (!isHandoffEntry(entry) || entry.running) continue
            if (entry.source.sessionID !== turn.sessionID || entry.source.messageID !== turn.messageID) continue
            if (directory !== undefined && entry.directory !== directory) continue
            if (match !== undefined) {
                return undefined
            }
            match = entry
        }
        if (match === undefined) {
            return undefined
        }

        return consumeHandoff(match)
    }

    function takeHandoffForToolCalls(turn: HandoffTurn, directory: string | undefined): PendingAgentHandoffEntry | undefined {
        return takeHandoffForTurn(turn, directory)
    }

    function takeHandoffForIdle(sessionID: string, directory: string | undefined): PendingAgentHandoffEntry | undefined {
        let match: PendingAgentHandoffEntry | undefined
        for (const entry of pending.values()) {
            if (!isHandoffEntry(entry) || entry.running || entry.source.sessionID !== sessionID) continue
            if (directory !== undefined && entry.directory !== directory) continue
            if (match !== undefined) return undefined
            match = entry
        }
        return match === undefined ? undefined : consumeHandoff(match)
    }

    function takeRestartForIdle(sessionID: string): PendingAgentRestartEntry | undefined {
        for (const entry of pending.values()) {
            if (isHandoffEntry(entry) || entry.running || entry.sessionID !== sessionID) continue
            entry.running = true
            stopWaiting(entry)
            return entry
        }
        return undefined
    }

    async function continueRestart(entry: PendingAgentRestartEntry): Promise<void> {
        try {
            const compaction = await entry.summarize()
            if (entry.cancelled || compaction.error !== undefined || compaction.data !== true) return
            await dispatchAutocodeAgentPrompt(
                entry.client,
                entry.directory,
                entry.sessionID,
                entry.targetAgent,
                entry.prompt,
                entry.resolvedModel,
            )
        }
        catch {
            // A terminal restart failure must not retry after this idle transition.
        }
        finally {
            clear(entry)
        }
    }

    async function reportHandoffFailure(
        entry: PendingAgentHandoffEntry,
        stage: PendingAgentHandoffLifecycleFailure["stage"],
        error: unknown,
        instruction: string,
    ): Promise<void> {
        clear(entry)
        try {
            await entry.reportLifecycleFailure({
                stage,
                error: normalizeError(error),
                instruction,
                source: {
                    sessionID: entry.source.sessionID,
                    title: entry.source.title,
                    messageID: entry.source.messageID,
                },
                destination: {
                    sessionID: entry.destination.sessionID,
                    title: entry.destination.title,
                },
            })
        }
        catch {
        }
    }

    async function continueHandoff(entry: PendingAgentHandoffEntry): Promise<void> {
        try {
            const response = await entry.client.session.update({
                path: { id: entry.source.sessionID },
                query: { directory: entry.directory },
                body: { title: formatHandoffSourceTitle(entry.source.title) },
            })
            if (response.data === undefined || response.error !== undefined) {
                const error = response.error ?? "Source session title update returned no data."
                await reportHandoffFailure(
                    entry,
                    "rename",
                    error,
                    "Resolve source session rename failure, then register handoff again.",
                )
                return
            }
        }
        catch (error) {
            await reportHandoffFailure(
                entry,
                "rename",
                error,
                "Resolve source session rename failure, then register handoff again.",
            )
            return
        }

        if (entry.cancelled) return

        try {
            const promptResult = await dispatchAutocodeAgentPrompt(
                entry.client,
                entry.directory,
                entry.destination.sessionID,
                entry.destination.agent,
                entry.destination.prompt,
                entry.destination.resolvedModel,
            )
            if ("error" in promptResult) {
                await reportHandoffFailure(
                    entry,
                    "prompt",
                    promptResult.error,
                    "Destination session was preserved; resume it manually after resolving the prompt failure.",
                )
            }
        }
        catch (error) {
            await reportHandoffFailure(
                entry,
                "prompt",
                error,
                "Destination session was preserved; resume it manually after resolving the prompt failure.",
            )
        }
        finally {
            clear(entry)
        }
    }

    return {
        register(restart: PendingAgentRestart): PendingAgentRestartRegistration {
            if (restart.abort?.aborted === true) return "aborted"

            const key = createRestartKey(restart.directory, restart.sessionID)
            if (pending.has(key)) return "duplicate"

            const entry: PendingAgentRestartEntry = { ...restart, key, running: false, cancelled: false }
            if (restart.abort) {
                entry.abortListener = () => clear(entry)
                restart.abort.addEventListener("abort", entry.abortListener, { once: true })
            }
            pending.set(key, entry)
            if (timeoutMs !== undefined) {
                const timer = setTimeout((): void => clear(entry), timeoutMs)
                entry.timer = timer
                unrefTimer(timer)
            }
            return "registered"
        },

        registerHandoff(handoff: PendingAgentHandoff): PendingAgentHandoffRegistration {
            if (handoff.abort?.aborted === true) {
                return {
                    status: "aborted",
                    error: "Handoff request was aborted before continuation could be scheduled.",
                    instruction: "Retry handoff after cancellation is cleared.",
                }
            }
            if (handoff.source.sessionID === handoff.destination.sessionID) {
                return {
                    status: "invalid",
                    error: "Source and destination sessions must be distinct.",
                    instruction: "Create a new destination session before registering handoff.",
                }
            }

            const key = createRestartKey(handoff.directory, handoff.source.sessionID)
            if (pending.has(key)) {
                return {
                    status: "duplicate",
                    error: "A continuation is already pending for this source session.",
                    instruction: "Wait for pending source-session handoff before requesting another continuation.",
                }
            }

            const entry: PendingAgentHandoffEntry = { ...handoff, key, running: false, cancelled: false }
            if (handoff.abort) {
                entry.abortListener = () => clear(entry)
                handoff.abort.addEventListener("abort", entry.abortListener, { once: true })
            }
            pending.set(key, entry)
            if (handoffTimeoutMs !== undefined) {
                const timer = setTimeout((): void => clear(entry), handoffTimeoutMs)
                entry.timer = timer
                unrefTimer(timer)
            }
            return {
                status: "registered",
                sourceSessionID: handoff.source.sessionID,
                destinationSessionID: handoff.destination.sessionID,
            }
        },

        async handleEvent(event: Event): Promise<void> {
            const completedAssistantSessionID = getCompletedAssistantMessageSessionID(event)
            const terminalMessagePartSessionID = getTerminalMessagePartSessionID(event)
            const toolCallsStepFinish = getToolCallsStepFinish(event)
            const handoffTurn = getHandoffTurn(event)
            const sessionID = getSessionID(event)
            const directory = getEventDirectory(event)
            if (toolCallsStepFinish !== undefined) {
                const handoff = takeHandoffForToolCalls(toolCallsStepFinish, directory)
                if (handoff !== undefined) {
                    await continueHandoff(handoff)
                }
                return
            }
            if (!sessionID) return
            if (event.type === "session.deleted" || event.type === "session.error") {
                clearSession(sessionID)
                return
            }
            if (isHandoffIdleEvent(event)) {
                const handoff = takeHandoffForIdle(sessionID, directory)
                if (handoff !== undefined) {
                    await continueHandoff(handoff)
                    return
                }
            }
            if (handoffTurn !== undefined) {
                const handoff = takeHandoffForTurn(handoffTurn, directory)
                if (handoff !== undefined) {
                    await continueHandoff(handoff)
                    return
                }
            }
            if (!isIdleEvent(event) && completedAssistantSessionID === undefined && terminalMessagePartSessionID === undefined) return

            const restart = takeRestartForIdle(sessionID)
            if (restart !== undefined) {
                await continueRestart(restart)
            }
        },

        dispose(): void {
            for (const entry of [...pending.values()]) clear(entry)
        },

        pendingCount(): number {
            return pending.size
        },
    }
}
