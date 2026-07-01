import { describe, expect, mock, test, beforeEach } from "bun:test"
import type { Event } from "@opencode-ai/sdk"
import { findPreviousPrimaryAutocodeAgent, resolveAutocodeAgentSessionSettings, swapCurrentAutocodeSession } from "@/utils/agent_swap"
import { createAgentSwitchBackHook } from "@/hooks/agent_switch_back"

const SWAP_BACK_PROMPT = "Present the next action to the user using the question tool."
const PRIMARY = ["assist", "auto", "design", "research"]

type SwapFn = typeof swapCurrentAutocodeSession
type ResolveFn = typeof resolveAutocodeAgentSessionSettings
type FindPrevFn = typeof findPreviousPrimaryAutocodeAgent

const swapMock = mock<SwapFn>(async () => ({ sessionID: "s1" }) as Awaited<ReturnType<SwapFn>>)
const resolveSettingsMock = mock<ResolveFn>(async () => ({ resolvedModel: {} }) as Awaited<ReturnType<ResolveFn>>)
const findPrevMock = mock<FindPrevFn>(async () => ({ skipped: true, reason: "none" }) as Awaited<ReturnType<FindPrevFn>>)

const client = {} as never
const DIRECTORY = "/dir"
const WORKTREE = "/work"

function event(e: unknown): { event: Event } {
    return { event: e as Event }
}
function updated(sessionID: string, agent: string) {
    return event({ type: "message.updated", properties: { info: { sessionID, agent } } })
}
function updatedMissing() {
    return event({ type: "message.updated", properties: { info: { sessionID: undefined, agent: undefined } } })
}
function idle(sessionID: string) {
    return event({ type: "session.idle", properties: { sessionID } })
}
function deletedById(sessionID: string) {
    return event({ type: "session.deleted", properties: { info: { id: sessionID } } })
}
function deletedBySessionID(sessionID: string) {
    return event({ type: "session.deleted", properties: { sessionID } })
}

describe("createAgentSwitchBackHook", () => {
    function createHandler() {
        return createAgentSwitchBackHook(client, DIRECTORY, WORKTREE, {
            swapCurrentAutocodeSession: swapMock as unknown as typeof swapCurrentAutocodeSession,
            resolveAutocodeAgentSessionSettings: resolveSettingsMock as unknown as typeof resolveAutocodeAgentSessionSettings,
            findPreviousPrimaryAutocodeAgent: findPrevMock as unknown as typeof findPreviousPrimaryAutocodeAgent,
        })
    }

    beforeEach(() => {
        swapMock.mockClear()
        resolveSettingsMock.mockClear()
        findPrevMock.mockClear()
        swapMock.mockImplementation(async () => ({ sessionID: "s1" }))
        resolveSettingsMock.mockImplementation(async () => ({ resolvedModel: {} }))
        findPrevMock.mockImplementation(async () => ({ skipped: true, reason: "none" }))
    })

    test("swaps to in-memory lastPrimary when temp_* session goes idle", async () => {
        const handler = createHandler()
        await handler(updated("s1", "auto"))
        await handler(updated("s1", "temp_concept"))
        await handler(idle("s1"))

        expect(findPrevMock).not.toHaveBeenCalled()
        expect(resolveSettingsMock).toHaveBeenCalledWith("auto", WORKTREE, DIRECTORY)
        expect(swapMock).toHaveBeenCalledTimes(1)
        const call = swapMock.mock.calls[0]
        expect(call[1]).toBe(DIRECTORY)
        expect(call[2]).toBe("s1")
        expect(call[3]).toBe("auto")
        expect(call[4]).toBe(SWAP_BACK_PROMPT)
        expect(call[5]).toEqual({})
    })

    test("uses findPreviousPrimaryAutocodeAgent fallback when no in-memory primary", async () => {
        findPrevMock.mockImplementation(async () => ({ agent: "design", skipped: false }))
        const handler = createHandler()
        await handler(updated("s1", "temp_concept"))
        await handler(idle("s1"))

        expect(findPrevMock).toHaveBeenCalledTimes(1)
        expect(findPrevMock.mock.calls[0][2]).toBe("s1")
        expect(swapMock).toHaveBeenCalledTimes(1)
        expect(swapMock.mock.calls[0][3]).toBe("design")
    })

    test("does not swap when fallback reports skipped", async () => {
        const handler = createHandler()
        await handler(updated("s1", "temp_concept"))
        await handler(idle("s1"))
        expect(swapMock).not.toHaveBeenCalled()
    })

    test("does not swap when fallback returns no agent", async () => {
        findPrevMock.mockImplementation(async () => ({ skipped: false }))
        const handler = createHandler()
        await handler(updated("s1", "temp_concept"))
        await handler(idle("s1"))
        expect(swapMock).not.toHaveBeenCalled()
    })

    test("does not swap when fallback errors", async () => {
        findPrevMock.mockImplementation(async () => ({ error: "boom", instruction: "" }))
        const handler = createHandler()
        await handler(updated("s1", "temp_concept"))
        await handler(idle("s1"))
        expect(swapMock).not.toHaveBeenCalled()
    })

    test("does not swap when no current agent tracked (cold idle)", async () => {
        const handler = createHandler()
        await handler(idle("s1"))
        expect(swapMock).not.toHaveBeenCalled()
        expect(findPrevMock).not.toHaveBeenCalled()
    })

    test("does not swap when current agent is primary", async () => {
        const handler = createHandler()
        await handler(updated("s1", "assist"))
        await handler(idle("s1"))
        expect(swapMock).not.toHaveBeenCalled()
    })

    test("does not swap when current agent is non-primary and non-temp", async () => {
        const handler = createHandler()
        await handler(updated("s1", "query_db"))
        await handler(idle("s1"))
        expect(swapMock).not.toHaveBeenCalled()
        expect(findPrevMock).not.toHaveBeenCalled()
    })

    test("does not swap when resolveAutocodeAgentSessionSettings errors", async () => {
        resolveSettingsMock.mockImplementation(async () => ({ error: "cfg", instruction: "" }))
        const handler = createHandler()
        await handler(updated("s1", "auto"))
        await handler(updated("s1", "temp_concept"))
        await handler(idle("s1"))
        expect(swapMock).not.toHaveBeenCalled()
    })

    test("does not update tracked agent when swap errors (retry on next idle)", async () => {
        swapMock.mockImplementation(async () => ({ error: "net", instruction: "" }))
        const handler = createHandler()
        await handler(updated("s1", "auto"))
        await handler(updated("s1", "temp_concept"))
        await handler(idle("s1"))
        await handler(idle("s1"))
        expect(swapMock).toHaveBeenCalledTimes(2)
    })

    test("after successful swap, second idle does not re-swap", async () => {
        const handler = createHandler()
        await handler(updated("s1", "auto"))
        await handler(updated("s1", "temp_concept"))
        await handler(idle("s1"))
        await handler(idle("s1"))
        expect(swapMock).toHaveBeenCalledTimes(1)
    })

    test("session.deleted clears tracked state (cold idle after delete)", async () => {
        const handler = createHandler()
        await handler(updated("s1", "auto"))
        await handler(updated("s1", "temp_concept"))
        await handler(deletedById("s1"))
        await handler(idle("s1"))
        expect(swapMock).not.toHaveBeenCalled()
    })

    test("session.deleted extracts id from properties.sessionID fallback", async () => {
        const handler = createHandler()
        await handler(updated("s1", "auto"))
        await handler(updated("s1", "temp_concept"))
        await handler(deletedBySessionID("s1"))
        await handler(idle("s1"))
        expect(swapMock).not.toHaveBeenCalled()
    })

    test("message.updated with missing sessionID/agent is ignored", async () => {
        const handler = createHandler()
        await handler(updatedMissing())
        await handler(idle("s1"))
        expect(swapMock).not.toHaveBeenCalled()
    })

    test("hook never throws (swallows internal errors)", async () => {
        swapMock.mockImplementation(async () => {
            throw new Error("kaboom")
        })
        const handler = createHandler()
        await handler(updated("s1", "auto"))
        await handler(updated("s1", "temp_concept"))
        await expect(handler(idle("s1"))).resolves.toBeUndefined()
    })

    test("other event types are ignored", async () => {
        const handler = createHandler()
        await handler(updated("s1", "auto"))
        await handler(updated("s1", "temp_concept"))
        await handler(event({ type: "session.created", properties: {} }))
        expect(swapMock).not.toHaveBeenCalled()
    })
})
