import { describe, expect, mock, spyOn, test, type Mock } from "bun:test"
import type { Event, OpencodeClient } from "@opencode-ai/sdk"
import type { ManagedScriptLifecycle, ManagedScriptLifecycleDependencies } from "./managed_script_lifecycle"
import type { SessionJobContext } from "@/utils/jobs"
import type {
    ManagedScriptRuntime,
    ManagedScriptRuntimeDependencies,
    ManagedScriptServiceCleanupResult,
    ManagedScriptServiceStartResult,
} from "@/utils/managed_script_runtime"

type CleanupManagedScriptServices = (runtime: Pick<ManagedScriptRuntime, "cleanup">) => Promise<ManagedScriptServiceCleanupResult>
type RuntimeFactory = NonNullable<ManagedScriptLifecycleDependencies["runtimeFactory"]>
type Cleanup = () => Promise<ManagedScriptServiceCleanupResult>

const SESSION_ID = "session-123"
const DIRECTORY = "/repo"
const WORKTREE = "/repo-worktree"
const CLEANUP_RESULT: ManagedScriptServiceCleanupResult = { stopped_run_ids: [], finalized_run_ids: [] }
const cleanupManagedScriptServicesMock = mock<CleanupManagedScriptServices>(async (runtime) => await runtime.cleanup())

await mock.module("@/utils/managed_script_runtime", () => ({
    cleanupManagedScriptServices: cleanupManagedScriptServicesMock,
    createManagedScriptRuntime: (): never => { throw new Error("Default runtime must not be created in lifecycle tests.") },
}))

const { createManagedScriptLifecycle } = await import("./managed_script_lifecycle")

type LifecycleHarness = {
    client: OpencodeClient
    cleanup: Mock<Cleanup>
    factory: Mock<RuntimeFactory>
    foreignKill: Mock<() => void>
    lifecycle: ManagedScriptLifecycle
    runtime: Pick<ManagedScriptRuntime, "cleanup"> & { kill: () => void }
}

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>["resolve"]
    let reject!: Deferred<T>["reject"]
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

function context(sessionID: string = SESSION_ID, directory: string = DIRECTORY, worktree: string = WORKTREE): SessionJobContext {
    return { sessionID, directory, worktree }
}

function startResult(runID: string = "run-123"): ManagedScriptServiceStartResult {
    return { run_id: runID, stdout_log_path: `/logs/${runID}.out`, stderr_log_path: `/logs/${runID}.err` }
}

function createHarness(): LifecycleHarness {
    cleanupManagedScriptServicesMock.mockClear()
    const cleanup = mock<Cleanup>(async (): Promise<ManagedScriptServiceCleanupResult> => CLEANUP_RESULT)
    const foreignKill = mock((): void => undefined)
    const runtime: LifecycleHarness["runtime"] = { cleanup, kill: foreignKill }
    const factory = mock<RuntimeFactory>(() => runtime as unknown as ManagedScriptRuntime)
    const client = {} as unknown as OpencodeClient
    return {
        client,
        cleanup,
        factory,
        foreignKill,
        lifecycle: createManagedScriptLifecycle({ client, runtimeFactory: factory }),
        runtime,
    }
}

function register(harness: LifecycleHarness, sessionContext: SessionJobContext = context(), runID: string = "run-123", abort: AbortSignal = new AbortController().signal): void {
    harness.lifecycle.registerStart(sessionContext, startResult(runID), abort)
}

function idleEvent(sessionID: string = SESSION_ID): Event {
    return { type: "session.idle", properties: { sessionID } } as unknown as Event
}

function expectCleanupOwnership(harness: LifecycleHarness, expectedContext: SessionJobContext): void {
    expect(cleanupManagedScriptServicesMock).toHaveBeenCalledWith(harness.runtime)
    expect(harness.factory).toHaveBeenCalledWith(expect.objectContaining({
        context: expectedContext,
        client: harness.client,
        resolveOwner: expect.any(Function),
    }))
}

describe("createManagedScriptLifecycle", () => {
    test.each([
        ["session idle", idleEvent()],
        ["idle status", { type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "idle" } } }],
        ["step ended properties", { type: "session.next.step.ended", properties: { sessionID: SESSION_ID } }],
        ["step ended data", { type: "session.next.step.ended", data: { sessionID: SESSION_ID } }],
        ["session error", { type: "session.error", properties: { sessionID: SESSION_ID, error: new Error("request aborted") } }],
        ["step failed", { type: "session.next.step.failed", data: { sessionID: SESSION_ID } }],
        ["deleted canonical ID", { type: "session.deleted", properties: { sessionID: SESSION_ID, info: { id: "other-session" } } }],
        ["deleted info ID fallback", { type: "session.deleted", properties: { info: { id: SESSION_ID } } }],
    ])("cleans owned service after %s", async (_name, event) => {
        const harness = createHarness()
        const ownedContext = context()
        register(harness, ownedContext, "owned-run")

        await harness.lifecycle.handleEvent(event as unknown as Event)

        expect(harness.cleanup).toHaveBeenCalledTimes(1)
        expectCleanupOwnership(harness, ownedContext)
    })

    test("cleans owned service after AbortSignal abort", async () => {
        const harness = createHarness()
        const controller = new AbortController()
        const ownedContext = context()
        register(harness, ownedContext, "aborted-run", controller.signal)

        controller.abort(new Error("request aborted"))
        await harness.lifecycle.dispose()

        expect(harness.cleanup).toHaveBeenCalledTimes(1)
        expectCleanupOwnership(harness, ownedContext)
    })

    test("does not clean for busy, retry, nonterminal, or unrelated events", async () => {
        const harness = createHarness()
        register(harness)

        await Promise.all([
            harness.lifecycle.handleEvent({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "busy" } } } as unknown as Event),
            harness.lifecycle.handleEvent({ type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "retry" } } } as unknown as Event),
            harness.lifecycle.handleEvent({ type: "session.next.step.started", data: { sessionID: SESSION_ID } } as unknown as Event),
            harness.lifecycle.handleEvent({ type: "message.updated", properties: { sessionID: SESSION_ID } } as unknown as Event),
            harness.lifecycle.handleEvent(idleEvent("other-session")),
        ])

        expect(harness.cleanup).not.toHaveBeenCalled()
        expect(cleanupManagedScriptServicesMock).not.toHaveBeenCalled()
    })

    test("coalesces concurrent terminal events into one serialized cleanup", async () => {
        const harness = createHarness()
        const cleanupGate = deferred<ManagedScriptServiceCleanupResult>()
        const order: string[] = []
        harness.cleanup.mockImplementation(async (): Promise<ManagedScriptServiceCleanupResult> => {
            order.push("cleanup started")
            const result = await cleanupGate.promise
            order.push("cleanup finished")
            return result
        })
        register(harness)

        const first = harness.lifecycle.handleEvent(idleEvent())
        const second = harness.lifecycle.handleEvent({ type: "session.error", properties: { sessionID: SESSION_ID } } as unknown as Event)
        await Promise.resolve()

        expect(harness.cleanup).toHaveBeenCalledTimes(1)
        expect(order).toEqual(["cleanup started"])
        cleanupGate.resolve(CLEANUP_RESULT)
        await Promise.all([first, second])

        expect(order).toEqual(["cleanup started", "cleanup finished"])
        expect(cleanupManagedScriptServicesMock).toHaveBeenCalledTimes(1)
    })

    test("groups multiple starts for one session into one owned cleanup", async () => {
        const harness = createHarness()
        const firstContext = context(SESSION_ID, DIRECTORY, WORKTREE)
        const laterContext = context(SESSION_ID, "/other-repo", "/other-worktree")
        register(harness, firstContext, "run-one")
        register(harness, laterContext, "run-two")

        await harness.lifecycle.handleEvent(idleEvent())

        expect(harness.cleanup).toHaveBeenCalledTimes(1)
        expectCleanupOwnership(harness, firstContext)
    })

    test("keeps start registered during active cleanup for next terminal cleanup", async () => {
        const harness = createHarness()
        const firstGate = deferred<ManagedScriptServiceCleanupResult>()
        const firstContext = context()
        const nextContext = context(SESSION_ID, "/next-repo", "/next-worktree")
        harness.cleanup.mockImplementationOnce(async (): Promise<ManagedScriptServiceCleanupResult> => await firstGate.promise)
        register(harness, firstContext, "first-run")

        const firstCleanup = harness.lifecycle.handleEvent(idleEvent())
        await Promise.resolve()
        register(harness, nextContext, "next-run")
        firstGate.resolve(CLEANUP_RESULT)
        await firstCleanup

        await harness.lifecycle.handleEvent(idleEvent())

        expect(harness.cleanup).toHaveBeenCalledTimes(2)
        expect(harness.factory.mock.calls.map(([dependencies]) => dependencies.context)).toEqual([firstContext, nextContext])
    })

    test("awaits start registered while dispose cleanup is active", async () => {
        const harness = createHarness()
        const firstGate = deferred<ManagedScriptServiceCleanupResult>()
        const secondGate = deferred<ManagedScriptServiceCleanupResult>()
        harness.cleanup
            .mockImplementationOnce(async (): Promise<ManagedScriptServiceCleanupResult> => await firstGate.promise)
            .mockImplementationOnce(async (): Promise<ManagedScriptServiceCleanupResult> => await secondGate.promise)
        register(harness, context(), "first-run")

        const disposing = harness.lifecycle.dispose()
        await Promise.resolve()
        register(harness, context("session-456", "/second-repo", "/second-worktree"), "second-run")
        firstGate.resolve(CLEANUP_RESULT)
        await Promise.resolve()

        expect(harness.cleanup).toHaveBeenCalledTimes(2)
        let disposed = false
        void disposing.then((): void => { disposed = true })
        await Promise.resolve()
        expect(disposed).toBeFalse()
        secondGate.resolve(CLEANUP_RESULT)
        await disposing

        expect(harness.factory.mock.calls.map(([dependencies]) => dependencies.context.sessionID)).toEqual([SESSION_ID, "session-456"])
    })

    test("makes repeat dispose idempotent", async () => {
        const harness = createHarness()
        register(harness)

        const first = harness.lifecycle.dispose()
        const second = harness.lifecycle.dispose()
        expect(first).toBe(second)
        await first
        const third = harness.lifecycle.dispose()

        expect(third).toBe(first)
        expect(harness.cleanup).toHaveBeenCalledTimes(1)
    })

    test("reports cleanup rejection without generic or foreign kill", async () => {
        const harness = createHarness()
        const cleanupFailure = new Error("owned cleanup unavailable")
        const warn = spyOn(console, "warn").mockImplementation((): void => undefined)
        harness.cleanup.mockImplementation(async (): Promise<ManagedScriptServiceCleanupResult> => { throw cleanupFailure })
        register(harness)

        try {
            await expect(harness.lifecycle.handleEvent(idleEvent())).resolves.toBeUndefined()

            expect(cleanupManagedScriptServicesMock).toHaveBeenCalledTimes(1)
            expect(warn).toHaveBeenCalledWith("autocode: cleanup managed script services failed: owned cleanup unavailable")
            expect(harness.foreignKill).not.toHaveBeenCalled()
        }
        finally {
            warn.mockRestore()
        }
    })
})
