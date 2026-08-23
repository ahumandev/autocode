import type { Event, OpencodeClient } from "@opencode-ai/sdk"
import { resolveManagedScriptProjectOwner } from "@/utils/managed_script_project"
import { cleanupManagedScriptServices, createManagedScriptRuntime, type ManagedScriptRuntime, type ManagedScriptRuntimeDependencies, type ManagedScriptServiceStartResult } from "@/utils/managed_script_runtime"
import type { SessionJobContext } from "@/utils/jobs"

export type ManagedScriptLifecycle = {
    registerStart(context: SessionJobContext, startResult: ManagedScriptServiceStartResult, abort: AbortSignal): void
    handleEvent(event: Event): Promise<void>
    dispose(): Promise<void>
}

export type ManagedScriptLifecycleDependencies = {
    client?: OpencodeClient
    runtimeFactory?: (dependencies: ManagedScriptRuntimeDependencies) => ManagedScriptRuntime
}

type ManagedScriptSessionEntry = {
    context: SessionJobContext
    runIDs: Set<string>
    abortListeners: Map<AbortSignal, () => void>
    cleanup?: Promise<void>
}

function getRecord(value: unknown, property: string): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || !(property in value)) return undefined
    const candidate = (value as Record<string, unknown>)[property]
    return typeof candidate === "object" && candidate !== null ? candidate as Record<string, unknown> : undefined
}

function getRecordString(value: unknown, property: string): string | undefined {
    if (typeof value !== "object" || value === null || !(property in value)) return undefined
    const candidate = (value as Record<string, unknown>)[property]
    return typeof candidate === "string" && candidate.trim() ? candidate : undefined
}

function getEventType(event: Event): string | undefined {
    return getRecordString(event, "type")
}

function getStepSessionID(event: Event): string | undefined {
    for (const value of [getRecord(event, "properties"), getRecord(event, "data")]) {
        const sessionID = getRecordString(value, "sessionID")
        if (sessionID !== undefined) return sessionID
    }
    return undefined
}

function getTerminalSessionID(event: Event): string | undefined {
    if (event.type === "session.status" || event.type === "session.idle" || event.type === "session.error") return event.properties.sessionID
    if (event.type === "session.deleted") {
        return getRecordString(event.properties, "sessionID") ?? getRecordString(getRecord(event.properties, "info"), "id")
    }
    if (getEventType(event) === "session.next.step.ended") return getStepSessionID(event)
    if (getEventType(event) === "session.next.step.failed") {
        return getRecordString(getRecord(event, "properties"), "sessionID")
            ?? getRecordString(getRecord(event, "data"), "sessionID")
    }
    return undefined
}

function isTerminalEvent(event: Event): boolean {
    if (event.type === "session.idle" || event.type === "session.error" || event.type === "session.deleted") return true
    if (event.type === "session.status") return event.properties.status.type === "idle"
    return getEventType(event) === "session.next.step.ended" || getEventType(event) === "session.next.step.failed"
}

function cleanupErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function reportCleanupFailure(error: unknown): void {
    console.warn(`autocode: cleanup managed script services failed: ${cleanupErrorMessage(error)}`)
}

export function createManagedScriptLifecycle(dependencies: ManagedScriptLifecycleDependencies = {}): ManagedScriptLifecycle {
    const entries = new Map<string, ManagedScriptSessionEntry>()
    const activeCleanups = new Set<Promise<void>>()
    const runtimeFactory = dependencies.runtimeFactory ?? createManagedScriptRuntime
    let disposing = false
    let disposed = false
    let disposePromise: Promise<void> | undefined

    function removeAbortListeners(entry: ManagedScriptSessionEntry): void {
        for (const [abort, listener] of entry.abortListeners) {
            abort.removeEventListener("abort", listener)
        }
        entry.abortListeners.clear()
    }

    function createSessionEntry(context: SessionJobContext): ManagedScriptSessionEntry {
        return {
            context: { sessionID: context.sessionID, directory: context.directory, worktree: context.worktree },
            runIDs: new Set<string>(),
            abortListeners: new Map<AbortSignal, () => void>(),
        }
    }

    async function cleanupEntry(sessionID: string, entry: ManagedScriptSessionEntry): Promise<void> {
        try {
            const context: SessionJobContext = { ...entry.context }
            const runtime = runtimeFactory({
                context,
                ...(dependencies.client ? { client: dependencies.client } : {}),
                resolveOwner: async () => await resolveManagedScriptProjectOwner({
                    context,
                    ...(dependencies.client ? { client: dependencies.client } : {}),
                }),
            })
            await cleanupManagedScriptServices(runtime)
        }
        finally {
            removeAbortListeners(entry)
            if (entries.get(sessionID) === entry) entries.delete(sessionID)
        }
    }

    function cleanupSession(sessionID: string): Promise<void> {
        const entry = entries.get(sessionID)
        if (entry === undefined) return Promise.resolve()
        if (entry.cleanup !== undefined) return entry.cleanup
        const cleanup = cleanupEntry(sessionID, entry)
        entry.cleanup = cleanup
        activeCleanups.add(cleanup)
        void cleanup.then(
            (): void => { activeCleanups.delete(cleanup) },
            (): void => { activeCleanups.delete(cleanup) },
        )
        return cleanup
    }

    function cleanupEntryForSession(sessionID: string, entry: ManagedScriptSessionEntry): Promise<void> {
        if (entries.get(sessionID) !== entry) return entry.cleanup ?? Promise.resolve()
        return cleanupSession(sessionID)
    }

    function registerAbort(entry: ManagedScriptSessionEntry, abort: AbortSignal): void {
        if (entry.abortListeners.has(abort)) return
        const listener = (): void => {
            void cleanupEntryForSession(entry.context.sessionID, entry).catch(reportCleanupFailure)
        }
        entry.abortListeners.set(abort, listener)
        abort.addEventListener("abort", listener, { once: true })
    }

    async function drainDisposal(): Promise<void> {
        while (entries.size > 0 || activeCleanups.size > 0) {
            const cleanups = new Set<Promise<void>>(activeCleanups)
            for (const sessionID of entries.keys()) {
                cleanups.add(cleanupSession(sessionID))
            }
            const results = await Promise.allSettled(cleanups)
            for (const result of results) {
                if (result.status === "rejected") reportCleanupFailure(result.reason)
            }
        }
    }

    async function finishDisposal(): Promise<void> {
        try {
            while (true) {
                await drainDisposal()
                if (entries.size === 0 && activeCleanups.size === 0) return
            }
        }
        catch (error) {
            reportCleanupFailure(error)
        }
        finally {
            disposing = false
            disposed = true
        }
    }

    return {
        registerStart(context: SessionJobContext, startResult: ManagedScriptServiceStartResult, abort: AbortSignal): void {
            const sessionID = context.sessionID
            const mustCleanup = disposing || disposed
            if (disposed) {
                disposed = false
                disposePromise = undefined
            }
            const existing = entries.get(sessionID)
            const entry = existing?.cleanup === undefined ? existing ?? createSessionEntry(context) : createSessionEntry(context)
            entries.set(sessionID, entry)
            entry.runIDs.add(startResult.run_id)
            registerAbort(entry, abort)
            if (abort.aborted) {
                void cleanupSession(sessionID).catch(reportCleanupFailure)
            }
            else if (mustCleanup) {
                void cleanupSession(sessionID).catch(reportCleanupFailure)
            }
        },

        async handleEvent(event: Event): Promise<void> {
            if (!isTerminalEvent(event)) return
            const sessionID = getTerminalSessionID(event)
            if (sessionID === undefined || !entries.has(sessionID)) return
            try {
                await cleanupSession(sessionID)
            }
            catch (error) {
                reportCleanupFailure(error)
            }
        },

        dispose(): Promise<void> {
            if (disposePromise !== undefined) return disposePromise
            disposing = true
            disposePromise = finishDisposal()
            return disposePromise
        },
    }
}
