import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk"
import { findActiveAutocodeAgent, restartAutocodeAgentInSession } from "@/hooks/agent_restart"
import type { AgentRestartDependencies, AgentRestartInput, readCurrentJobPlan, summarizeAutocodeAgentSession } from "@/hooks/agent_restart"
import { createPendingAgentRestartCoordinator, type PendingAgentRestartCoordinator } from "@/hooks/agent_restart_coordinator"
import type { resolveAutocodeAgentSessionSettings } from "@/utils/agent_swap"

type FindActiveFn = typeof findActiveAutocodeAgent
type ResolveSettingsFn = typeof resolveAutocodeAgentSessionSettings
type SummarizeFn = typeof summarizeAutocodeAgentSession
type ReadCurrentJobPlanFn = typeof readCurrentJobPlan

const SESSION_ID = "session-123"
const DIRECTORY = "/repo"
const WORKTREE = "/repo-worktree"
const sessionCreateMock = mock(async (): Promise<never> => {
    throw new Error("session.create must not be called")
})
const findActiveMock = mock<FindActiveFn>(async () => ({ currentAgent: "assist" }))
const resolveSettingsMock = mock<ResolveSettingsFn>(async () => ({
    resolvedModel: { model: { providerID: "openai", modelID: "gpt-5" }, variant: "high" },
}))
const summarizeMock = mock<SummarizeFn>(async () => ({ data: true }))
const readCurrentJobPlanMock = mock<ReadCurrentJobPlanFn>(async () => undefined)
const promptAsyncMock = mock(async () => ({}))
const client = { session: { create: sessionCreateMock, promptAsync: promptAsyncMock } } as unknown as AgentRestartInput["client"]
const terminalConfigurations: Array<[string, () => void]> = [
    ["summary false", (): void => { summarizeMock.mockImplementation(async () => ({ data: false })) }],
    ["summary throws", (): void => { summarizeMock.mockImplementation(async () => { throw new Error("summary unavailable") }) }],
    ["continuation fails", (): void => { promptAsyncMock.mockImplementation(async () => { throw new Error("queue unavailable") }) }],
]

function idleEvent(): Event {
    return {
        type: "session.status",
        properties: { sessionID: SESSION_ID, status: { type: "idle" } },
    } as unknown as Event
}

function sessionEvent(type: "session.deleted" | "session.error"): Event {
    if (type === "session.deleted") {
        return { type, properties: { info: { id: SESSION_ID } } } as unknown as Event
    }
    return { type, properties: { sessionID: SESSION_ID } } as unknown as Event
}

function input(coordinator: PendingAgentRestartCoordinator, targetAgent: unknown = "auto", abort?: AbortSignal): AgentRestartInput {
    return {
        client,
        context: { sessionID: SESSION_ID, directory: DIRECTORY, worktree: WORKTREE },
        targetAgent,
        abort,
        coordinator,
    }
}

function dependencies(): AgentRestartDependencies {
    return {
        findActiveAutocodeAgent: findActiveMock,
        resolveAutocodeAgentSessionSettings: resolveSettingsMock,
        summarizeAutocodeAgentSession: summarizeMock,
        readCurrentJobPlan: readCurrentJobPlanMock,
    }
}

describe("restartAutocodeAgentInSession", () => {
    let coordinator: PendingAgentRestartCoordinator

    beforeEach(() => {
        coordinator = createPendingAgentRestartCoordinator()
        sessionCreateMock.mockClear()
        findActiveMock.mockClear()
        resolveSettingsMock.mockClear()
        summarizeMock.mockClear()
        readCurrentJobPlanMock.mockClear()
        promptAsyncMock.mockClear()
        findActiveMock.mockImplementation(async () => ({ currentAgent: "assist" }))
        resolveSettingsMock.mockImplementation(async () => ({
            resolvedModel: { model: { providerID: "openai", modelID: "gpt-5" }, variant: "high" },
        }))
        summarizeMock.mockImplementation(async () => ({ data: true }))
        readCurrentJobPlanMock.mockImplementation(async () => undefined)
        promptAsyncMock.mockImplementation(async () => ({}))
    })

    test("returns pending restart without compaction or continuation in active tool turn", async () => {
        const response = JSON.parse(await restartAutocodeAgentInSession(input(coordinator, "advise"), dependencies())) as Record<string, unknown>

        expect(response).toEqual({
            session_id: SESSION_ID,
            current_agent: "assist",
            target_agent: "advise",
            compaction_pending: true,
            continuation_pending: true,
        })
        expect(summarizeMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)
    })

    test("summarizes once then immediately continues once on matching idle", async () => {
        const order: string[] = []
        summarizeMock.mockImplementation(async () => {
            order.push("summarize")
            return { data: true }
        })
        promptAsyncMock.mockImplementation(async () => {
            order.push("prompt")
            return {}
        })

        await restartAutocodeAgentInSession(input(coordinator, "advise"), dependencies())
        await coordinator.handleEvent(idleEvent())

        expect(order).toEqual(["summarize", "prompt"])
        expect(summarizeMock).toHaveBeenCalledWith(client, DIRECTORY, SESSION_ID, { providerID: "openai", modelID: "gpt-5" })
        expect(promptAsyncMock).toHaveBeenCalledWith({
            path: { id: SESSION_ID },
            query: { directory: DIRECTORY },
            body: {
                agent: "advise",
                model: { providerID: "openai", modelID: "gpt-5", variant: "high" },
                parts: [{ type: "text", text: "Research possibilities regarding recent discussion and continue manual practice guidance without project implementation." }],
            },
        })
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("preserves selected job plan in deferred assist continuation", async () => {
        readCurrentJobPlanMock.mockImplementation(async () => ({ jobName: "current_job", plan: "# Current plan" }))

        await restartAutocodeAgentInSession(input(coordinator, "assist"), dependencies())
        await coordinator.handleEvent(idleEvent())

        expect(promptAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
            body: expect.objectContaining({
                parts: [expect.objectContaining({ text: "Selected job: current_job\n\nplan.md:\n# Current plan" })],
            }),
        }))
        expect(sessionCreateMock).not.toHaveBeenCalled()
    })

    test("consumes repeated and concurrent idle events before compaction awaits", async () => {
        await restartAutocodeAgentInSession(input(coordinator), dependencies())
        await Promise.all([coordinator.handleEvent(idleEvent()), coordinator.handleEvent(idleEvent())])

        expect(summarizeMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(coordinator.pendingCount()).toBe(0)
    })

    test.each(terminalConfigurations)("cleans pending restart when %s", async (_label, configure) => {
        configure()
        await restartAutocodeAgentInSession(input(coordinator), dependencies())
        await coordinator.handleEvent(idleEvent())

        expect(coordinator.pendingCount()).toBe(0)
        await restartAutocodeAgentInSession(input(coordinator), dependencies())
        expect(coordinator.pendingCount()).toBe(1)
    })

    test("removes pending restart on abort, deleted session, and session error", async () => {
        const controller = new AbortController()
        await restartAutocodeAgentInSession(input(coordinator, "auto", controller.signal), dependencies())
        controller.abort()
        await coordinator.handleEvent(idleEvent())
        expect(summarizeMock).not.toHaveBeenCalled()

        await restartAutocodeAgentInSession(input(coordinator), dependencies())
        await coordinator.handleEvent(sessionEvent("session.deleted"))
        await coordinator.handleEvent(idleEvent())
        expect(summarizeMock).not.toHaveBeenCalled()

        await restartAutocodeAgentInSession(input(coordinator), dependencies())
        await coordinator.handleEvent(sessionEvent("session.error"))
        await coordinator.handleEvent(idleEvent())
        expect(summarizeMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(0)
        await restartAutocodeAgentInSession(input(coordinator), dependencies())
        expect(coordinator.pendingCount()).toBe(1)
    })

    test("does not register an already-aborted request or a duplicate pending restart", async () => {
        const controller = new AbortController()
        controller.abort()
        const aborted = JSON.parse(await restartAutocodeAgentInSession(input(coordinator, "auto", controller.signal), dependencies())) as Record<string, string>
        expect(aborted.failedAction).toBe("restart registration")
        expect(coordinator.pendingCount()).toBe(0)

        await restartAutocodeAgentInSession(input(coordinator), dependencies())
        const duplicate = JSON.parse(await restartAutocodeAgentInSession(input(coordinator), dependencies())) as Record<string, string>
        expect(duplicate.failedAction).toBe("restart registration")
        await coordinator.handleEvent(idleEvent())
        expect(summarizeMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    })

    test("rejects duplicate registration while matching idle compaction is running", async () => {
        let beginSummary: (() => void) | undefined
        let finishSummary: (() => void) | undefined
        const summaryStarted = new Promise<void>((resolve) => {
            beginSummary = resolve
        })
        const summaryFinished = new Promise<void>((resolve) => {
            finishSummary = resolve
        })
        summarizeMock.mockImplementation(async () => {
            beginSummary?.()
            await summaryFinished
            return { data: true }
        })

        await restartAutocodeAgentInSession(input(coordinator), dependencies())
        const idle = coordinator.handleEvent(idleEvent())
        await summaryStarted
        const duplicate = JSON.parse(await restartAutocodeAgentInSession(input(coordinator), dependencies())) as Record<string, string>
        finishSummary?.()
        await idle

        expect(duplicate.failedAction).toBe("restart registration")
        expect(summarizeMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("cleans a timed out pending restart without execution", async () => {
        coordinator = createPendingAgentRestartCoordinator(1)
        await restartAutocodeAgentInSession(input(coordinator), dependencies())
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        await coordinator.handleEvent(idleEvent())

        expect(coordinator.pendingCount()).toBe(0)
        expect(summarizeMock).not.toHaveBeenCalled()
        await restartAutocodeAgentInSession(input(coordinator), dependencies())
        expect(coordinator.pendingCount()).toBe(1)
    })

    test("blocks registration for invalid target or missing current agent", async () => {
        const invalid = JSON.parse(await restartAutocodeAgentInSession(input(coordinator, "temporary"), dependencies())) as Record<string, string>
        expect(invalid.failedAction).toBe("validation")
        expect(coordinator.pendingCount()).toBe(0)

        findActiveMock.mockImplementation(async () => ({ error: "No active agent" }))
        const missing = JSON.parse(await restartAutocodeAgentInSession(input(coordinator), dependencies())) as Record<string, string>
        expect(missing.failedAction).toBe("validation")
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("reports when newest session history has no user message", async () => {
        const historyClient = { session: { messages: mock(async () => ({ data: [] })) } } as unknown as Parameters<typeof findActiveAutocodeAgent>[0]

        expect(await findActiveAutocodeAgent(historyClient, DIRECTORY, SESSION_ID)).toEqual({
            error: "Unable to identify current agent from newest session user message.",
        })
    })
})
