import type { Event, OpencodeClient } from "@opencode-ai/sdk"
import { dispatchAutocodeAgentPrompt, type PrimaryAutocodeAgent, type ResolvedAgentModel } from "@/utils/agent_swap"

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

export type PendingAgentRestartCoordinator = {
    register(restart: PendingAgentRestart): PendingAgentRestartRegistration
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

function createRestartKey(directory: string, sessionID: string): string {
    return `${directory}\u0000${sessionID}`
}

function getSessionID(event: Event): string | undefined {
    if (event.type === "session.deleted") return event.properties.info.id
    if (event.type === "session.error") return event.properties.sessionID
    if (event.type === "session.status" || event.type === "session.idle") return event.properties.sessionID
    return undefined
}

function isIdleEvent(event: Event): boolean {
    return (event.type === "session.status" && event.properties.status.type === "idle") || event.type === "session.idle"
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
    if (typeof timer !== "object" || timer === null || !("unref" in timer)) return
    const unref = timer.unref
    if (typeof unref === "function") unref.call(timer)
}

export function createPendingAgentRestartCoordinator(
    timeoutMs?: number,
): PendingAgentRestartCoordinator {
    const pending = new Map<string, PendingAgentRestartEntry>()

    function stopWaiting(entry: PendingAgentRestartEntry): void {
        if (entry.timer !== undefined) {
            clearTimeout(entry.timer)
            entry.timer = undefined
        }
        if (entry.abort && entry.abortListener) {
            entry.abort.removeEventListener("abort", entry.abortListener)
        }
    }

    function clear(entry: PendingAgentRestartEntry): void {
        if (pending.get(entry.key) !== entry) return
        pending.delete(entry.key)
        entry.cancelled = true
        stopWaiting(entry)
    }

    function clearSession(sessionID: string): void {
        for (const entry of pending.values()) {
            if (entry.sessionID === sessionID) clear(entry)
        }
    }

    function takeForIdle(sessionID: string): PendingAgentRestartEntry | undefined {
        for (const entry of pending.values()) {
            if (entry.sessionID === sessionID && !entry.running) {
                entry.running = true
                stopWaiting(entry)
                return entry
            }
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

        async handleEvent(event: Event): Promise<void> {
            const sessionID = getSessionID(event)
            if (!sessionID) return
            if (event.type === "session.deleted" || event.type === "session.error") {
                clearSession(sessionID)
                return
            }
            if (!isIdleEvent(event)) return

            const entry = takeForIdle(sessionID)
            if (entry) await continueRestart(entry)
        },

        dispose(): void {
            for (const entry of [...pending.values()]) clear(entry)
        },

        pendingCount(): number {
            return pending.size
        },
    }
}
