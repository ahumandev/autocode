import { beforeEach, describe, expect, mock, test } from "bun:test"
import {
    findActiveAutocodeAgent,
    restartAutocodeAgentInSession,
} from "@/hooks/agent_restart"
import type {
    AgentRestartDependencies,
    AgentRestartInput,
    summarizeAutocodeAgentSession,
} from "@/hooks/agent_restart"
import { dispatchAutocodeAgentPrompt } from "@/utils/agent_swap"
import type { resolveAutocodeAgentSessionSettings } from "@/utils/agent_swap"

type FindActiveFn = typeof findActiveAutocodeAgent
type ResolveSettingsFn = typeof resolveAutocodeAgentSessionSettings
type SummarizeFn = typeof summarizeAutocodeAgentSession
type DispatchFn = typeof dispatchAutocodeAgentPrompt

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
const dispatchMock = mock<DispatchFn>(async () => ({ sessionID: SESSION_ID }))
const promptAsyncMock = mock(async () => ({}))
const client = { session: { create: sessionCreateMock, promptAsync: promptAsyncMock } } as unknown as AgentRestartInput["client"]

function input(targetAgent: unknown = "auto"): AgentRestartInput {
    return {
        client,
        context: { sessionID: SESSION_ID, directory: DIRECTORY, worktree: WORKTREE },
        targetAgent,
    }
}

function dependencies(): AgentRestartDependencies {
    return {
        findActiveAutocodeAgent: findActiveMock,
        resolveAutocodeAgentSessionSettings: resolveSettingsMock,
        summarizeAutocodeAgentSession: summarizeMock,
        dispatchAutocodeAgentPrompt: dispatchMock,
    }
}

describe("restartAutocodeAgentInSession", () => {
    beforeEach(() => {
        sessionCreateMock.mockClear()
        findActiveMock.mockClear()
        resolveSettingsMock.mockClear()
        summarizeMock.mockClear()
        dispatchMock.mockClear()
        promptAsyncMock.mockClear()
        findActiveMock.mockImplementation(async () => ({ currentAgent: "assist" }))
        resolveSettingsMock.mockImplementation(async () => ({
            resolvedModel: { model: { providerID: "openai", modelID: "gpt-5" }, variant: "high" },
        }))
        summarizeMock.mockImplementation(async () => ({ data: true }))
        dispatchMock.mockImplementation(async () => ({ sessionID: SESSION_ID }))
    })

    test("forwards resolved model and reasoning variant to restart dispatch", async () => {
        dispatchMock.mockImplementation(dispatchAutocodeAgentPrompt)

        await restartAutocodeAgentInSession(input(), dependencies())

        expect(summarizeMock).toHaveBeenCalledWith(client, DIRECTORY, SESSION_ID, {
            providerID: "openai",
            modelID: "gpt-5",
        })
        expect(dispatchMock.mock.calls[0][5]).toEqual({
            model: { providerID: "openai", modelID: "gpt-5" },
            variant: "high",
        })
        expect(promptAsyncMock).toHaveBeenCalledWith({
            path: { id: SESSION_ID },
            query: { directory: DIRECTORY },
            body: expect.objectContaining({
                model: { providerID: "openai", modelID: "gpt-5", variant: "high" },
            }),
        })
    })

    test("resolves, discovers, compacts, then dispatches in same session without creating one", async () => {
        const order: string[] = []
        resolveSettingsMock.mockImplementation(async () => {
            order.push("resolve")
            return { resolvedModel: { model: { providerID: "openai", modelID: "gpt-5" } } }
        })
        findActiveMock.mockImplementation(async () => {
            order.push("discover")
            return { currentAgent: "assist" }
        })
        summarizeMock.mockImplementation(async () => {
            order.push("summarize")
            return { data: true }
        })
        dispatchMock.mockImplementation(async () => {
            order.push("dispatch")
            return { sessionID: SESSION_ID }
        })

        await restartAutocodeAgentInSession(input("research"), dependencies())

        expect(order).toEqual(["resolve", "discover", "summarize", "dispatch"])
        expect(resolveSettingsMock).toHaveBeenCalledWith("research", WORKTREE, DIRECTORY)
        expect(findActiveMock).toHaveBeenCalledWith(client, DIRECTORY, SESSION_ID)
        expect(summarizeMock.mock.calls[0].slice(0, 3)).toEqual([client, DIRECTORY, SESSION_ID])
        expect(dispatchMock.mock.calls[0].slice(0, 4)).toEqual([client, DIRECTORY, SESSION_ID, "research"])
        expect(sessionCreateMock).not.toHaveBeenCalled()
    })

    test("blocks dispatch and reports structured compaction failure", async () => {
        summarizeMock.mockImplementation(async () => ({ error: "summary unavailable" }))

        const response = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, string>

        expect(response.failedAction).toBe("compaction")
        expect(response.error).toContain("summary unavailable")
        expect(response.instruction).toContain("same-session compaction")
        expect(dispatchMock).not.toHaveBeenCalled()
    })

    test("blocks dispatch when compaction throws", async () => {
        summarizeMock.mockImplementation(async () => {
            throw new Error("summary unavailable")
        })

        const response = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, string>

        expect(response.failedAction).toBe("compaction")
        expect(response.error).toContain("summary unavailable")
        expect(dispatchMock).not.toHaveBeenCalled()
    })

    test("blocks dispatch when compaction reports data false", async () => {
        summarizeMock.mockImplementation(async () => ({ data: false }))

        const response = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, string>

        expect(response.failedAction).toBe("compaction")
        expect(response.error).toBe("Session compaction did not complete.")
        expect(response.instruction).toContain("Retry same-session compaction")
        expect(dispatchMock).not.toHaveBeenCalled()
    })

    test("reports continuation dispatch failure after compaction completes", async () => {
        dispatchMock.mockImplementation(async () => ({ error: "queue unavailable", instruction: "" }))

        const response = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, string>

        expect(summarizeMock).toHaveBeenCalledTimes(1)
        expect(response.failedAction).toBe("continuation dispatch")
        expect(response.error).toContain("Compaction completed")
        expect(response.error).toContain("queue unavailable")
        expect(response.instruction).toContain("compaction completed")
    })

    test("reports thrown continuation dispatch failure after compaction completes", async () => {
        dispatchMock.mockImplementation(async () => {
            throw new Error("queue unavailable")
        })

        const response = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, string>

        expect(summarizeMock).toHaveBeenCalledTimes(1)
        expect(response.failedAction).toBe("continuation dispatch")
        expect(response.error).toContain("Compaction completed")
        expect(response.error).toContain("queue unavailable")
        expect(response.instruction).toContain("compaction completed")
    })

    test("blocks compaction and dispatch for missing active agent and unsupported target", async () => {
        findActiveMock.mockImplementation(async () => ({ error: "No active agent" }))

        const missingActiveResponse = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, string>

        expect(missingActiveResponse.failedAction).toBe("validation")
        expect(summarizeMock).not.toHaveBeenCalled()
        expect(dispatchMock).not.toHaveBeenCalled()

        findActiveMock.mockClear()
        resolveSettingsMock.mockClear()
        const unsupportedTargetResponse = JSON.parse(await restartAutocodeAgentInSession(input("temporary"), dependencies())) as Record<string, string>

        expect(unsupportedTargetResponse.failedAction).toBe("validation")
        expect(unsupportedTargetResponse.error).toContain("Invalid target agent")
        expect(resolveSettingsMock).not.toHaveBeenCalled()
        expect(findActiveMock).not.toHaveBeenCalled()
        expect(summarizeMock).not.toHaveBeenCalled()
        expect(dispatchMock).not.toHaveBeenCalled()
    })

    test("blocks compaction and dispatch for unsupported discovered agent", async () => {
        findActiveMock.mockImplementation(async () => ({ error: "Unsupported current agent in newest session user message." }))

        const response = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, string>

        expect(response.failedAction).toBe("validation")
        expect(response.error).toContain("Unsupported current agent in newest session user message.")
        expect(summarizeMock).not.toHaveBeenCalled()
        expect(dispatchMock).not.toHaveBeenCalled()
    })

    test("blocks all injected side effects for invalid input", async () => {
        const response = JSON.parse(await restartAutocodeAgentInSession(input(null), dependencies())) as Record<string, string>

        expect(response.failedAction).toBe("validation")
        expect(findActiveMock).not.toHaveBeenCalled()
        expect(resolveSettingsMock).not.toHaveBeenCalled()
        expect(summarizeMock).not.toHaveBeenCalled()
        expect(dispatchMock).not.toHaveBeenCalled()
        expect(sessionCreateMock).not.toHaveBeenCalled()
    })

    test("reports when newest session history has no user message", async () => {
        const historyClient = {
            session: { messages: mock(async () => ({ data: [] })) },
        } as unknown as Parameters<typeof findActiveAutocodeAgent>[0]

        const response = await findActiveAutocodeAgent(historyClient, DIRECTORY, SESSION_ID)

        expect(response).toEqual({ error: "Unable to identify current agent from newest session user message." })
    })
})
