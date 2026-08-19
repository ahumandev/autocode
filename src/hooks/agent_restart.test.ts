import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk"
import { findActiveAutocodeAgent, restartAutocodeAgentInSession } from "@/hooks/agent_restart"
import type { AgentRestartDependencies, AgentRestartInput, readCurrentJobPlan, summarizeAutocodeAgentSession } from "@/hooks/agent_restart"
import {
    DEFAULT_AGENT_HANDOFF_TIMEOUT_MS,
    createPendingAgentRestartCoordinator,
    type PendingAgentHandoff,
    type PendingAgentHandoffLifecycleFailure,
    type PendingAgentRestartCoordinator,
} from "@/hooks/agent_restart_coordinator"
import type { resolveAutocodeAgentSessionSettings } from "@/utils/agent_swap"

type FindActiveFn = typeof findActiveAutocodeAgent
type ResolveSettingsFn = typeof resolveAutocodeAgentSessionSettings
type SummarizeFn = typeof summarizeAutocodeAgentSession
type ReadCurrentJobPlanFn = typeof readCurrentJobPlan
type PromptAsyncFn = NonNullable<AgentRestartInput["client"]["session"]["promptAsync"]>
type PromptAsyncMock = (...args: Parameters<PromptAsyncFn>) => ReturnType<PromptAsyncFn>

const SESSION_ID = "session-123"
const DESTINATION_SESSION_ID = "session-456"
const SOURCE_MESSAGE_ID = "assistant-message-123"
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
function promptAsyncSuccess(..._args: Parameters<PromptAsyncFn>): ReturnType<PromptAsyncFn> {
    return Promise.resolve({
        data: undefined,
        error: undefined,
        request: new Request("http://localhost"),
        response: new Response(null, { status: 204 }),
    })
}

const promptAsyncMock = mock<PromptAsyncMock>(promptAsyncSuccess)
const client = { session: { create: sessionCreateMock, promptAsync: promptAsyncMock } } as unknown as AgentRestartInput["client"]
const sessionUpdateMock = mock(async (..._args: unknown[]): Promise<unknown> => ({ data: {} }))
const sessionDeleteMock = mock(async (..._args: unknown[]): Promise<unknown> => ({ data: {} }))
const handoffClient = { session: { update: sessionUpdateMock, delete: sessionDeleteMock, promptAsync: promptAsyncMock } } as unknown as PendingAgentHandoff["client"]
const lifecycleReporterMock = mock(async (_failure: PendingAgentHandoffLifecycleFailure): Promise<void> => undefined)
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

function handoffTurnEndedEvent(
    directory: string = DIRECTORY,
    sessionID: string = SESSION_ID,
    assistantMessageID: string = SOURCE_MESSAGE_ID,
): Event {
    return {
        type: "session.next.step.ended",
        directory,
        data: { sessionID, assistantMessageID, finish: "stop" },
    } as unknown as Event
}

function liveHandoffTurnEndedEvent(
    directory: string = DIRECTORY,
    sessionID: string = SESSION_ID,
    messageID: string = SOURCE_MESSAGE_ID,
): Event {
    return {
        type: "session.next.step.ended",
        directory,
        data: { sessionID, messageID, finish: "stop" },
    } as unknown as Event
}

function sdkHandoffIdleEvent(sessionID: string = SESSION_ID): Event {
    return { type: "session.idle", properties: { sessionID } } as unknown as Event
}

function handoffStatusIdleEvent(sessionID: string = SESSION_ID): Event {
    return { type: "session.status", properties: { sessionID, status: { type: "idle" } } } as unknown as Event
}

function stepEndedEvent(finish: string, shape: "data" | "properties" = "data"): Event {
    return {
        type: "session.next.step.ended",
        [shape]: { sessionID: SESSION_ID, assistantMessageID: SOURCE_MESSAGE_ID, finish },
    } as unknown as Event
}

function stepFinishPartUpdatedEvent(reason: string = "stop", partSessionID?: string): Event {
    return {
        type: "message.part.updated",
        properties: {
            sessionID: SESSION_ID,
            part: {
                type: "step-finish",
                reason,
                messageID: SOURCE_MESSAGE_ID,
                ...(partSessionID === undefined ? {} : { sessionID: partSessionID }),
            },
        },
    } as unknown as Event
}

function completedAssistantMessageUpdatedEvent(
    completed: number = 1,
    finish?: string,
    sessionID: string = SESSION_ID,
    messageID: string = SOURCE_MESSAGE_ID,
): Event {
    return {
        type: "message.updated",
        properties: { info: { id: messageID, sessionID, role: "assistant", time: { completed }, ...(finish === undefined ? {} : { finish }) } },
    } as unknown as Event
}

function liveStepFinishPartUpdatedEvent(
    reason: "stop" | "tool-calls",
    messageID: string,
    sessionID: string = SESSION_ID,
    directory: string = DIRECTORY,
): Event {
    return {
        type: "message.part.updated",
        properties: { directory, sessionID, part: { type: "step-finish", reason, messageID } },
    } as unknown as Event
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

function handoff(abort?: AbortSignal, sourceTitle: string = "Source session"): PendingAgentHandoff {
    return {
        client: handoffClient,
        directory: DIRECTORY,
        source: { sessionID: SESSION_ID, title: sourceTitle, messageID: SOURCE_MESSAGE_ID },
        destination: {
            sessionID: DESTINATION_SESSION_ID,
            title: "Destination session",
            agent: "advise",
            prompt: "Continue separate-session handoff.",
            resolvedModel: { model: { providerID: "openai", modelID: "gpt-5" }, variant: "high" },
        },
        abort,
        reportLifecycleFailure: lifecycleReporterMock,
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
        promptAsyncMock.mockImplementation(promptAsyncSuccess)
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
        promptAsyncMock.mockImplementation((...args: Parameters<PromptAsyncFn>): ReturnType<PromptAsyncFn> => {
            order.push("prompt")
            return promptAsyncSuccess(...args)
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

    test("retains pending restart past old default timeout until matching idle", async () => {
        jest.useFakeTimers()
        try {
            await restartAutocodeAgentInSession(input(coordinator, "advise"), dependencies())
            jest.advanceTimersByTime(60_001)

            expect(coordinator.pendingCount()).toBe(1)
            await coordinator.handleEvent(idleEvent())

            expect(summarizeMock).toHaveBeenCalledTimes(1)
            expect(promptAsyncMock).toHaveBeenCalledTimes(1)
            expect(coordinator.pendingCount()).toBe(0)
        }
        finally {
            coordinator.dispose()
            jest.useRealTimers()
        }
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
        jest.useFakeTimers()
        jest.setSystemTime(new Date(2026, 0, 2, 3, 4))
        try {
            coordinator = createPendingAgentRestartCoordinator(1)
            await restartAutocodeAgentInSession(input(coordinator), dependencies())
            jest.advanceTimersByTime(5)
            await coordinator.handleEvent(idleEvent())

            expect(coordinator.pendingCount()).toBe(0)
            expect(summarizeMock).not.toHaveBeenCalled()
            await restartAutocodeAgentInSession(input(coordinator), dependencies())
            expect(coordinator.pendingCount()).toBe(1)
        }
        finally {
            coordinator.dispose()
            jest.useRealTimers()
        }
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

describe("PendingAgentRestartCoordinator handoffs", () => {
    let coordinator: PendingAgentRestartCoordinator

    beforeEach(() => {
        coordinator = createPendingAgentRestartCoordinator()
        sessionUpdateMock.mockClear()
        sessionDeleteMock.mockClear()
        promptAsyncMock.mockClear()
        summarizeMock.mockClear()
        lifecycleReporterMock.mockClear()
        sessionUpdateMock.mockImplementation(async () => ({ data: {} }))
        promptAsyncMock.mockImplementation(promptAsyncSuccess)
        lifecycleReporterMock.mockImplementation(async (): Promise<void> => undefined)
    })

    afterEach(() => {
        coordinator.dispose()
    })

    test("registers handoff without work before matching tool-calls step finish and returns source-destination boundary", () => {
        expect(coordinator.registerHandoff(handoff())).toEqual({
            status: "registered",
            sourceSessionID: SESSION_ID,
            destinationSessionID: DESTINATION_SESSION_ID,
        })
        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)
    })

    test("rejects overlapping source and destination sessions without scheduling handoff", () => {
        const overlapping = handoff()

        expect(coordinator.registerHandoff({
            ...overlapping,
            destination: { ...overlapping.destination, sessionID: SESSION_ID },
        })).toEqual({
            status: "invalid",
            error: "Source and destination sessions must be distinct.",
            instruction: "Create a new destination session before registering handoff.",
        })
        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("requires matching source session and directory turn, renames source, then prompts destination", async () => {
        const order: string[] = []
        sessionUpdateMock.mockImplementation(async () => {
            order.push("rename")
            return { data: {} }
        })
        promptAsyncMock.mockImplementation((...args: Parameters<PromptAsyncFn>): ReturnType<PromptAsyncFn> => {
            order.push("prompt")
            return promptAsyncSuccess(...args)
        })

        coordinator.registerHandoff(handoff())
        await coordinator.handleEvent(handoffTurnEndedEvent(DIRECTORY, "wrong-source-session"))
        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)

        await coordinator.handleEvent(handoffTurnEndedEvent("/other-repo"))
        expect(sessionUpdateMock).not.toHaveBeenCalled()

        await coordinator.handleEvent(handoffTurnEndedEvent())

        expect(order).toEqual(["rename", "prompt"])
        expect(sessionUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
            path: { id: SESSION_ID },
            query: { directory: DIRECTORY },
        }))
        expect(promptAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
            path: { id: DESTINATION_SESSION_ID },
            query: { directory: DIRECTORY },
        }))
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("continues handoff only after matching source SDK status idle", async () => {
        coordinator.registerHandoff(handoff())

        await coordinator.handleEvent(handoffStatusIdleEvent("unrelated-session"))
        await coordinator.handleEvent(handoffStatusIdleEvent(DESTINATION_SESSION_ID))

        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)

        await coordinator.handleEvent(handoffStatusIdleEvent())

        expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("continues handoff from matching legacy SDK idle", async () => {
        coordinator.registerHandoff(handoff())

        await coordinator.handleEvent(sdkHandoffIdleEvent())

        expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("continues handoff from completed assistant message once", async () => {
        coordinator.registerHandoff(handoff())

        await coordinator.handleEvent(completedAssistantMessageUpdatedEvent())

        expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("does not continue handoff from completed tool-call assistant message", async () => {
        coordinator.registerHandoff(handoff())

        await coordinator.handleEvent(completedAssistantMessageUpdatedEvent(1, "tool-calls"))

        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)
    })

    test("keeps handoff pending after incomplete assistant message", async () => {
        coordinator.registerHandoff(handoff())

        await coordinator.handleEvent({
            type: "message.updated",
            properties: { info: { sessionID: SESSION_ID, role: "assistant", time: {} } },
        } as unknown as Event)

        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)
    })

    test("keeps handoff pending after completed user message", async () => {
        coordinator.registerHandoff(handoff())

        await coordinator.handleEvent({
            type: "message.updated",
            properties: { info: { sessionID: SESSION_ID, role: "user", time: { completed: 1 } } },
        } as unknown as Event)

        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)
    })

    test.each([
        ["completed assistant message", {
            type: "message.updated",
            properties: { info: { id: "stale-message", sessionID: SESSION_ID, role: "assistant", time: { completed: 1 } } },
        }],
        ["terminal message part", {
            type: "message.part.updated",
            properties: { sessionID: SESSION_ID, part: { type: "step-finish", reason: "stop", messageID: "stale-message" } },
        }],
        ["terminal step", {
            type: "session.next.step.ended",
            data: { sessionID: SESSION_ID, assistantMessageID: "stale-message", finish: "stop" },
        }],
    ] as const)("keeps handoff pending after stale %s", async (_label, event) => {
        coordinator.registerHandoff(handoff())

        await coordinator.handleEvent(event as unknown as Event)

        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)
    })

    test("continues pending restart after unmatched terminal handoff event", async () => {
        const unrelatedHandoff = handoff()
        findActiveMock.mockImplementation(async () => ({ currentAgent: "assist" }))
        resolveSettingsMock.mockImplementation(async () => ({
            resolvedModel: { model: { providerID: "openai", modelID: "gpt-5" }, variant: "high" },
        }))
        summarizeMock.mockClear()
        summarizeMock.mockImplementation(async () => ({ data: true }))
        coordinator.registerHandoff({
            ...unrelatedHandoff,
            source: { ...unrelatedHandoff.source, sessionID: "other-source-session", messageID: "other-source-message" },
        })
        await restartAutocodeAgentInSession(input(coordinator, "advise"), dependencies())

        await coordinator.handleEvent(handoffTurnEndedEvent(DIRECTORY, SESSION_ID, "stale-message"))

        expect(summarizeMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(coordinator.pendingCount()).toBe(1)
    })

    test("runs duplicate completed assistant messages once", async () => {
        coordinator.registerHandoff(handoff())

        await Promise.all([
            coordinator.handleEvent(completedAssistantMessageUpdatedEvent()),
            coordinator.handleEvent(completedAssistantMessageUpdatedEvent()),
        ])

        expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
        expect(sessionUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ path: { id: SESSION_ID } }))
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ path: { id: DESTINATION_SESSION_ID } }))
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("continues a uniquely matched handoff once from live terminal step finish parts", async () => {
        coordinator.registerHandoff(handoff())

        await Promise.all([
            coordinator.handleEvent(stepFinishPartUpdatedEvent()),
            coordinator.handleEvent(stepFinishPartUpdatedEvent()),
        ])

        expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("dispatches matching real tool-calls step finish once", async () => {
        coordinator.registerHandoff(handoff())

        await Promise.all([
            coordinator.handleEvent(liveStepFinishPartUpdatedEvent("tool-calls", SOURCE_MESSAGE_ID)),
            coordinator.handleEvent(liveStepFinishPartUpdatedEvent("tool-calls", SOURCE_MESSAGE_ID)),
        ])

        expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ path: { id: DESTINATION_SESSION_ID } }))
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("dispatches uniquely matched real tool-calls step finish without directory", async () => {
        coordinator.registerHandoff(handoff())

        await coordinator.handleEvent({
            type: "message.part.updated",
            properties: {
                sessionID: SESSION_ID,
                part: { type: "step-finish", reason: "tool-calls", messageID: SOURCE_MESSAGE_ID },
            },
        } as unknown as Event)

        expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("does not duplicate matching tool-calls handoff after later source stop or idle", async () => {
        coordinator.registerHandoff(handoff())
        await coordinator.handleEvent(liveStepFinishPartUpdatedEvent("tool-calls", SOURCE_MESSAGE_ID))

        await Promise.all([
            coordinator.handleEvent(liveStepFinishPartUpdatedEvent("stop", SOURCE_MESSAGE_ID)),
            coordinator.handleEvent(handoffStatusIdleEvent()),
            coordinator.handleEvent(sdkHandoffIdleEvent()),
        ])

        expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(coordinator.pendingCount()).toBe(0)
    })

    test.each([
        ["wrong directory", liveStepFinishPartUpdatedEvent("tool-calls", SOURCE_MESSAGE_ID, SESSION_ID, "/other-repo")],
        ["wrong source session", liveStepFinishPartUpdatedEvent("tool-calls", SOURCE_MESSAGE_ID, "other-source-session")],
        ["wrong stored message", liveStepFinishPartUpdatedEvent("tool-calls", "other-source-message")],
    ])("does not dispatch handoff from %s tool-calls step finish", async (_label, toolCallsEvent) => {
        coordinator.registerHandoff(handoff())

        await coordinator.handleEvent(toolCallsEvent)

        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)
    })

    test("continues once from live terminal message ID after nonmatching and duplicate events", async () => {
        jest.useFakeTimers()
        jest.setSystemTime(new Date(2026, 0, 2, 3, 4))
        try {
            coordinator.registerHandoff(handoff())
            await coordinator.handleEvent(liveHandoffTurnEndedEvent(DIRECTORY, SESSION_ID, "stale-message"))

            expect(sessionUpdateMock).not.toHaveBeenCalled()
            expect(promptAsyncMock).not.toHaveBeenCalled()

            await Promise.all([
                coordinator.handleEvent(liveHandoffTurnEndedEvent()),
                coordinator.handleEvent(liveHandoffTurnEndedEvent()),
            ])

            expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
            expect(sessionUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
                body: { title: "Source session (2026-01-02 03:04)" },
            }))
            expect(promptAsyncMock).toHaveBeenCalledTimes(1)
            expect(promptAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ path: { id: DESTINATION_SESSION_ID } }))
            expect(coordinator.pendingCount()).toBe(0)
        }
        finally {
            jest.useRealTimers()
        }
    })

    test.each([
        ["completed tool", { directory: DIRECTORY, sessionID: SESSION_ID, part: { type: "tool", state: "completed", messageID: SOURCE_MESSAGE_ID } }],
        ["failed tool", { sessionID: SESSION_ID, part: { type: "tool", state: "error" } }],
        ["text", { sessionID: SESSION_ID, part: { type: "text", text: "Done" } }],
        ["tool-calls step finish without message ID", { directory: DIRECTORY, sessionID: SESSION_ID, part: { type: "step-finish", reason: "tool-calls" } }],
        ["missing properties session ID", { part: { type: "step-finish", reason: "stop" } }],
        ["blank properties session ID", { sessionID: " ", part: { type: "step-finish", reason: "stop" } }],
        ["mismatched part session ID", { sessionID: SESSION_ID, part: { type: "step-finish", reason: "stop", sessionID: "other-session" } }],
    ])("keeps handoff pending after %s message part update", async (_label, properties) => {
        coordinator.registerHandoff(handoff())
        await coordinator.handleEvent({
            type: "message.part.updated",
            properties,
        } as unknown as Event)

        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)
    })

    for (const shape of ["data", "properties"] as const) {
        test(`continues uniquely matched handoff once from ${shape} terminal step ended event`, async () => {
            coordinator.registerHandoff(handoff())

            await Promise.all([
                coordinator.handleEvent(stepEndedEvent("stop", shape)),
                coordinator.handleEvent(stepEndedEvent("stop", shape)),
            ])

            expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
            expect(promptAsyncMock).toHaveBeenCalledTimes(1)
            expect(coordinator.pendingCount()).toBe(0)
        })
    }

    test("keeps handoff pending after tool-call step until terminal step ended event", async () => {
        coordinator.registerHandoff(handoff())

        await coordinator.handleEvent(stepEndedEvent("tool-calls"))

        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)

        await coordinator.handleEvent(stepEndedEvent("stop"))

        expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("ignores malformed step ended event", async () => {
        coordinator.registerHandoff(handoff())

        await coordinator.handleEvent({ type: "session.next.step.ended", data: { sessionID: SESSION_ID } } as unknown as Event)

        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)
    })

    test("keeps ambiguous handoffs pending when SDK idle omits directory", async () => {
        const otherHandoff = handoff()
        coordinator.registerHandoff(handoff())
        coordinator.registerHandoff({
            ...otherHandoff,
            directory: "/other-repo",
            destination: { ...otherHandoff.destination, sessionID: "other-destination-session" },
        })

        await coordinator.handleEvent(sdkHandoffIdleEvent())

        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(2)
    })

    test("renames Base Title with cleaned prior suffix and zero-padded local timestamp", async () => {
        jest.useFakeTimers()
        const localTime = new Date(2026, 0, 2, 3, 4)
        jest.setSystemTime(localTime)
        try {
            coordinator.registerHandoff(handoff(undefined, "Base Title (2025-12-31 23:59)"))
            await coordinator.handleEvent(handoffTurnEndedEvent())

            const update = sessionUpdateMock.mock.calls[0]?.[0] as { body: { title: string } }
            expect(update.body.title).toBe("Base Title (2026-01-02 03:04)")
        }
        finally {
            jest.useRealTimers()
        }
    })

    test("rejects duplicate registration and runs concurrent matching idle once", async () => {
        expect(coordinator.registerHandoff(handoff())).toMatchObject({ status: "registered" })
        expect(coordinator.registerHandoff(handoff())).toMatchObject({ status: "duplicate" })

        await Promise.all([coordinator.handleEvent(handoffTurnEndedEvent()), coordinator.handleEvent(handoffTurnEndedEvent())])

        expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("expires timed out handoff without rename or prompt", async () => {
        jest.useFakeTimers()
        jest.setSystemTime(new Date(2026, 0, 2, 3, 4))
        try {
            coordinator = createPendingAgentRestartCoordinator(1)
            coordinator.registerHandoff(handoff())
            jest.advanceTimersByTime(5)
            await coordinator.handleEvent(handoffTurnEndedEvent())

            expect(sessionUpdateMock).not.toHaveBeenCalled()
            expect(promptAsyncMock).not.toHaveBeenCalled()
            expect(coordinator.pendingCount()).toBe(0)
        }
        finally {
            coordinator.dispose()
            jest.useRealTimers()
        }
    })

    test("expires default handoffs without limiting restarts", async () => {
        jest.useFakeTimers()
        try {
            const timedOutHandoff = {
                ...handoff(),
                source: { ...handoff().source, sessionID: "timed-out-source-session", title: "Timed out source session" },
            }
            coordinator.registerHandoff(timedOutHandoff)
            await restartAutocodeAgentInSession(input(coordinator, "advise"), dependencies())
            jest.advanceTimersByTime(DEFAULT_AGENT_HANDOFF_TIMEOUT_MS + 1)

            expect(coordinator.pendingCount()).toBe(1)
            await coordinator.handleEvent(handoffTurnEndedEvent(DIRECTORY, timedOutHandoff.source.sessionID))
            expect(sessionUpdateMock).not.toHaveBeenCalled()
            expect(promptAsyncMock).not.toHaveBeenCalled()

            await coordinator.handleEvent(idleEvent())
            expect(summarizeMock).toHaveBeenCalledTimes(1)
            expect(promptAsyncMock).toHaveBeenCalledTimes(1)
            expect(coordinator.pendingCount()).toBe(0)
        }
        finally {
            coordinator.dispose()
            jest.useRealTimers()
        }
    })

    test("clears aborted and disposed handoffs without work", async () => {
        const controller = new AbortController()
        coordinator.registerHandoff(handoff(controller.signal))
        controller.abort()
        await coordinator.handleEvent(handoffTurnEndedEvent())

        coordinator.registerHandoff(handoff())
        coordinator.dispose()
        await coordinator.handleEvent(handoffTurnEndedEvent())

        expect(sessionUpdateMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(0)
    })

    test.each([
        ["returns structured error", async (): Promise<{ data: undefined, error: string }> => ({ data: undefined, error: "rename unavailable" })],
        ["throws", async (): Promise<never> => { throw new Error("rename unavailable") }],
    ])("reports rename failure when update %s and prevents destination prompt", async (_label, update) => {
        sessionUpdateMock.mockImplementation(update)
        coordinator.registerHandoff(handoff())
        await coordinator.handleEvent(handoffTurnEndedEvent())

        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(lifecycleReporterMock).toHaveBeenCalledWith(expect.objectContaining({
            stage: "rename",
            source: { sessionID: SESSION_ID, title: "Source session", messageID: SOURCE_MESSAGE_ID },
            destination: { sessionID: DESTINATION_SESSION_ID, title: "Destination session" },
        }))
        expect(coordinator.pendingCount()).toBe(0)
    })

    test.each([
        ["returns structured error", (): ReturnType<PromptAsyncFn> => Promise.resolve({
            data: undefined,
            error: "destination unavailable",
            request: new Request("http://localhost"),
            response: new Response(null, { status: 500 }),
        } as unknown as Awaited<ReturnType<PromptAsyncFn>>)],
        ["throws", async (): Promise<never> => { throw new Error("destination unavailable") }],
    ])("reports prompt failure when destination prompt %s and preserves destination", async (_label, prompt) => {
        promptAsyncMock.mockImplementation(prompt)
        coordinator.registerHandoff(handoff())
        await coordinator.handleEvent(handoffTurnEndedEvent())

        expect(sessionUpdateMock).toHaveBeenCalledTimes(1)
        expect(sessionUpdateMock).toHaveBeenCalledWith(expect.objectContaining({ path: { id: SESSION_ID } }))
        expect(sessionUpdateMock).not.toHaveBeenCalledWith(expect.objectContaining({ path: { id: DESTINATION_SESSION_ID } }))
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ path: { id: DESTINATION_SESSION_ID } }))
        expect(sessionDeleteMock).not.toHaveBeenCalled()
        expect(lifecycleReporterMock).toHaveBeenCalledWith(expect.objectContaining({
            stage: "prompt",
            instruction: "Destination session was preserved; resume it manually after resolving the prompt failure.",
            destination: { sessionID: DESTINATION_SESSION_ID, title: "Destination session" },
        }))
        expect(coordinator.pendingCount()).toBe(0)
    })

    test("contains lifecycle reporter rejection after a handoff failure", async () => {
        sessionUpdateMock.mockImplementation(async () => ({ data: undefined, error: "rename unavailable" }))
        lifecycleReporterMock.mockImplementation(async (): Promise<void> => { throw new Error("report unavailable") })
        coordinator.registerHandoff(handoff())

        await expect(coordinator.handleEvent(handoffTurnEndedEvent())).resolves.toBeUndefined()

        expect(lifecycleReporterMock).toHaveBeenCalledTimes(1)
        expect(promptAsyncMock).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(0)
    })
})
