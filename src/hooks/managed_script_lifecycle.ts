import type { Event, OpencodeClient } from "@opencode-ai/sdk"
import type { ManagedScriptProjectOwnerResolution } from "@/utils/managed_script_project"
import { cleanupManagedScriptServices, createManagedScriptRuntime, type ManagedScriptLaunchOwner, type ManagedScriptRuntime, type ManagedScriptRuntimeDependencies, type ManagedScriptServiceStartResult } from "@/utils/managed_script_runtime"
import type { SessionJobContext } from "@/utils/jobs"

const maximumCleanupAttempts = 3

export type ManagedScriptLifecycle = {
    registerStart(context: SessionJobContext, startResult: ManagedScriptServiceStartResult, abort: AbortSignal): void
    handleEvent(event: Event): Promise<void>
    dispose(): Promise<void>
}

export type ManagedScriptLifecycleDependencies = {
    client?: OpencodeClient
    runtimeFactory?: (dependencies: ManagedScriptRuntimeDependencies) => ManagedScriptRuntime
    createRuntime?: (context: SessionJobContext, owner: ManagedScriptLaunchOwner) => ManagedScriptRuntime
}

type ManagedScriptRegisteredLaunch = {
    context: SessionJobContext
    owner: ManagedScriptLaunchOwner
    cleanupAttempts: number
}

type ManagedScriptSessionEntry = {
    context: SessionJobContext
    launches: Map<string, ManagedScriptRegisteredLaunch>
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

function getCleanupResultFailure(result: unknown): Error | undefined {
    if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined
    const record = result as Record<string, unknown>
    const error = record.error
    const hasError = (typeof error === "string" && error.trim().length > 0)
        || (typeof error === "object" && error !== null && !Array.isArray(error))
    const hasFailures = [record.failed_run_ids, record.failures, record.errors]
        .some((value: unknown): boolean => Array.isArray(value) && value.length > 0)
    if (record.ok !== false && record.success !== false && !hasError && !hasFailures) return undefined
    const details: unknown[] = [
        error,
        record,
        ...(Array.isArray(record.failures) ? record.failures : []),
        ...(Array.isArray(record.errors) ? record.errors : []),
    ]
    const message = details.map((value: unknown): string | undefined => {
        if (typeof value === "string") return value.trim() ? value : undefined
        return getRecordString(value, "message")
    }).find((value: string | undefined): boolean => value !== undefined)
    return new Error(message ?? "Managed script service cleanup reported failure.")
}

function hasRetryableLaunches(entry: ManagedScriptSessionEntry): boolean {
    for (const launch of entry.launches.values()) {
        if (launch.cleanupAttempts < maximumCleanupAttempts) return true
    }
    return false
}

export function createManagedScriptLifecycle(dependencies: ManagedScriptLifecycleDependencies = {}): ManagedScriptLifecycle {
    const entries = new Map<string, ManagedScriptSessionEntry>()
    const activeCleanups = new Set<Promise<void>>()
    const runtimeFactory = dependencies.runtimeFactory ?? createManagedScriptRuntime
    const createRuntime = dependencies.createRuntime ?? ((context: SessionJobContext, owner: ManagedScriptLaunchOwner): ManagedScriptRuntime => runtimeFactory({
        context,
        ...(dependencies.client ? { client: dependencies.client } : {}),
        resolveOwner: async (): Promise<ManagedScriptProjectOwnerResolution> => ({
            ok: true,
            owner: { jobName: owner.jobName, directory: owner.directory },
        }),
    }))
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
            context,
            launches: new Map<string, ManagedScriptRegisteredLaunch>(),
            abortListeners: new Map<AbortSignal, () => void>(),
        }
    }

    async function cleanupEntry(sessionID: string, entry: ManagedScriptSessionEntry): Promise<void> {
        const owners = new Map<string, Map<string, ManagedScriptRegisteredLaunch>>()
        for (const [runID, launch] of entry.launches) {
            const key = JSON.stringify([launch.owner.directory, launch.owner.jobName, launch.owner.sessionID])
            const launches = owners.get(key) ?? new Map<string, ManagedScriptRegisteredLaunch>()
            launches.set(runID, launch)
            owners.set(key, launches)
        }
        const results = await Promise.allSettled(Array.from(owners.values(), async (launches: Map<string, ManagedScriptRegisteredLaunch>): Promise<void> => {
            const launch = Array.from(launches.values()).find((candidate: ManagedScriptRegisteredLaunch): boolean => candidate.cleanupAttempts < maximumCleanupAttempts)
            if (launch === undefined) return
            for (const candidate of launches.values()) {
                if (candidate.cleanupAttempts < maximumCleanupAttempts) candidate.cleanupAttempts += 1
            }
            const runtime = createRuntime(launch.context, launch.owner)
            const failure = getCleanupResultFailure(await cleanupManagedScriptServices(runtime))
            if (failure !== undefined) throw failure
            for (const [runID, candidate] of launches) {
                if (entry.launches.get(runID) === candidate) entry.launches.delete(runID)
            }
        }))
        if (entry.launches.size === 0) {
            removeAbortListeners(entry)
            if (entries.get(sessionID) === entry) entries.delete(sessionID)
        }
        for (const result of results) {
            if (result.status === "rejected") reportCleanupFailure(result.reason)
        }
    }

    function cleanupSession(sessionID: string): Promise<void> {
        const entry = entries.get(sessionID)
        if (entry === undefined) return Promise.resolve()
        if (entry.cleanup !== undefined) return entry.cleanup
        if (!hasRetryableLaunches(entry)) return Promise.resolve()
        // Publish cleanup before factories can synchronously register another launch.
        const cleanup = Promise.resolve().then((): Promise<void> => cleanupEntry(sessionID, entry))
        entry.cleanup = cleanup
        activeCleanups.add(cleanup)
        const clearCleanup = (): void => {
            if (entry.cleanup === cleanup) delete entry.cleanup
            activeCleanups.delete(cleanup)
        }
        void cleanup.then(clearCleanup, clearCleanup)
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
        while (true) {
            const cleanups = new Set<Promise<void>>(activeCleanups)
            for (const [sessionID, entry] of entries) {
                if (entry.cleanup !== undefined || hasRetryableLaunches(entry)) cleanups.add(cleanupSession(sessionID))
            }
            if (cleanups.size === 0) return
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
                if (activeCleanups.size === 0 && !Array.from(entries.values()).some(hasRetryableLaunches)) return
            }
        }
        catch (error) {
            reportCleanupFailure(error)
        }
        finally {
            for (const entry of entries.values()) removeAbortListeners(entry)
            disposing = false
            disposed = true
        }
    }

    return {
        registerStart(context: SessionJobContext, startResult: ManagedScriptServiceStartResult, abort: AbortSignal): void {
            const owner: ManagedScriptLaunchOwner = Object.freeze({
                jobName: startResult.owner.jobName,
                directory: startResult.owner.directory,
                sessionID: startResult.owner.sessionID,
            })
            const launchContext: SessionJobContext = Object.freeze({ sessionID: owner.sessionID, directory: owner.directory, worktree: context.worktree })
            const sessionID = owner.sessionID
            const mustCleanup = disposing || disposed
            if (disposed) {
                disposed = false
                disposePromise = undefined
            }
            const entry = entries.get(sessionID) ?? createSessionEntry(launchContext)
            entries.set(sessionID, entry)
            entry.launches.set(startResult.run_id, { context: launchContext, owner, cleanupAttempts: 0 })
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
