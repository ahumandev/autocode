import { beforeEach, describe, expect, mock, test } from "bun:test"
import {
    findActiveAutocodeAgent,
    restartAutocodeAgentInSession,
} from "@/hooks/agent_restart"
import type {
    AgentRestartDependencies,
    AgentRestartInput,
    readCurrentJobPlan,
    summarizeAutocodeAgentSession,
} from "@/hooks/agent_restart"
import { RESTART_ADVISE_PROMPT, RESTART_ASSIST_PROMPT, RESTART_AUTO_PROMPT } from "@/hooks/agent_restart_prompt"
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
        readCurrentJobPlan: readCurrentJobPlanMock,
    }
}

describe("restartAutocodeAgentInSession", () => {
    beforeEach(() => {
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
    })

    function waitForPostTurnDispatch(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 0))
    }

    test("forwards resolved model and reasoning variant to restart dispatch", async () => {
        await restartAutocodeAgentInSession(input(), dependencies())
        await waitForPostTurnDispatch()

        expect(summarizeMock).toHaveBeenCalledWith(client, DIRECTORY, SESSION_ID, {
            providerID: "openai",
            modelID: "gpt-5",
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
        promptAsyncMock.mockImplementation(async () => {
            order.push("dispatch")
            return {}
        })

        await restartAutocodeAgentInSession(input("advise"), dependencies())
        await waitForPostTurnDispatch()

        expect(order).toEqual(["resolve", "discover", "summarize", "dispatch"])
        expect(resolveSettingsMock).toHaveBeenCalledWith("advise", WORKTREE, DIRECTORY)
        expect(findActiveMock).toHaveBeenCalledWith(client, DIRECTORY, SESSION_ID)
        expect(summarizeMock.mock.calls[0].slice(0, 3)).toEqual([client, DIRECTORY, SESSION_ID])
        expect(promptAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
            path: { id: SESSION_ID },
            query: { directory: DIRECTORY },
            body: expect.objectContaining({ agent: "advise" }),
        }))
        expect(sessionCreateMock).not.toHaveBeenCalled()
    })

    test("injects current job name and plan for assist and auto restart", async () => {
        readCurrentJobPlanMock.mockImplementation(async () => ({ jobName: "current_job", plan: "# Current plan" }))

        await restartAutocodeAgentInSession(input("assist"), dependencies())
        await waitForPostTurnDispatch()

        expect(promptAsyncMock.mock.calls[0][0].body.parts[0].text).toBe("Selected job: current_job\n\nplan.md:\n# Current plan")

        promptAsyncMock.mockClear()
        await restartAutocodeAgentInSession(input("auto"), dependencies())
        await waitForPostTurnDispatch()
        expect(promptAsyncMock.mock.calls[0][0].body.parts[0].text).toBe("Selected job: current_job\n\nplan.md:\n# Current plan")
    })

    test("uses exact assist and auto fallback prompts when current job plan is unavailable", async () => {
        await restartAutocodeAgentInSession(input("assist"), dependencies())
        await waitForPostTurnDispatch()
        expect(promptAsyncMock.mock.calls[0][0].body.parts[0].text).toBe(RESTART_ASSIST_PROMPT)

        promptAsyncMock.mockClear()
        await restartAutocodeAgentInSession(input("auto"), dependencies())
        await waitForPostTurnDispatch()
        expect(promptAsyncMock.mock.calls[0][0].body.parts[0].text).toBe(RESTART_AUTO_PROMPT)
    })

    test("restarts advise in the same session with research and manual-guidance prompt", async () => {
        await restartAutocodeAgentInSession(input("advise"), dependencies())
        await waitForPostTurnDispatch()

        expect(promptAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
            path: { id: SESSION_ID },
            query: { directory: DIRECTORY },
            body: expect.objectContaining({
                agent: "advise",
                parts: [{ type: "text", text: RESTART_ADVISE_PROMPT }],
            }),
        })
        expect(readCurrentJobPlanMock).not.toHaveBeenCalled()
        expect(sessionCreateMock).not.toHaveBeenCalled()
    })

    test("blocks dispatch and reports structured compaction failure", async () => {
        summarizeMock.mockImplementation(async () => ({ error: "summary unavailable" }))

        const response = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, string>

        expect(response.failedAction).toBe("compaction")
        expect(response.error).toContain("summary unavailable")
        expect(response.instruction).toContain("same-session compaction")
        expect(promptAsyncMock).not.toHaveBeenCalled()
    })

    test("blocks dispatch when compaction throws", async () => {
        summarizeMock.mockImplementation(async () => {
            throw new Error("summary unavailable")
        })

        const response = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, string>

        expect(response.failedAction).toBe("compaction")
        expect(response.error).toContain("summary unavailable")
        expect(promptAsyncMock).not.toHaveBeenCalled()
    })

    test("blocks dispatch when compaction reports data false", async () => {
        summarizeMock.mockImplementation(async () => ({ data: false }))

        const response = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, string>

        expect(response.failedAction).toBe("compaction")
        expect(response.error).toBe("Session compaction did not complete.")
        expect(response.instruction).toContain("Retry same-session compaction")
        expect(promptAsyncMock).not.toHaveBeenCalled()
    })

    test("returns restart success when deferred continuation dispatch reports an error", async () => {
        promptAsyncMock.mockImplementation(async () => ({ error: "queue unavailable" }))
        const response = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, unknown>
        await waitForPostTurnDispatch()

        expect(summarizeMock).toHaveBeenCalledTimes(1)
        expect(response.continuation_dispatched).toBe(true)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    })

    test("returns restart success when deferred continuation dispatch throws", async () => {
        promptAsyncMock.mockImplementation(async () => {
            throw new Error("queue unavailable")
        })

        const response = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, unknown>
        await waitForPostTurnDispatch()

        expect(summarizeMock).toHaveBeenCalledTimes(1)
        expect(response.continuation_dispatched).toBe(true)
        expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    })

    test("blocks compaction and dispatch for missing active agent and unsupported target", async () => {
        findActiveMock.mockImplementation(async () => ({ error: "No active agent" }))

        const missingActiveResponse = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, string>

        expect(missingActiveResponse.failedAction).toBe("validation")
        expect(summarizeMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()

        findActiveMock.mockClear()
        resolveSettingsMock.mockClear()
        const unsupportedTargetResponse = JSON.parse(await restartAutocodeAgentInSession(input("temporary"), dependencies())) as Record<string, string>

        expect(unsupportedTargetResponse.failedAction).toBe("validation")
        expect(unsupportedTargetResponse.error).toContain("Invalid target agent")
        expect(resolveSettingsMock).not.toHaveBeenCalled()
        expect(findActiveMock).not.toHaveBeenCalled()
        expect(summarizeMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
    })

    test("blocks compaction and dispatch for unsupported discovered agent", async () => {
        findActiveMock.mockImplementation(async () => ({ error: "Unsupported current agent in newest session user message." }))

        const response = JSON.parse(await restartAutocodeAgentInSession(input(), dependencies())) as Record<string, string>

        expect(response.failedAction).toBe("validation")
        expect(response.error).toContain("Unsupported current agent in newest session user message.")
        expect(summarizeMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
    })

    test("blocks all injected side effects for invalid input", async () => {
        const response = JSON.parse(await restartAutocodeAgentInSession(input(null), dependencies())) as Record<string, string>

        expect(response.failedAction).toBe("validation")
        expect(findActiveMock).not.toHaveBeenCalled()
        expect(resolveSettingsMock).not.toHaveBeenCalled()
        expect(summarizeMock).not.toHaveBeenCalled()
        expect(promptAsyncMock).not.toHaveBeenCalled()
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
