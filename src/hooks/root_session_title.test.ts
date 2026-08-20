import { describe, expect, mock, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk"
import {
    createRootSessionTitleHook,
    parseRootSessionTitleHeading,
    reconcileRootSessionTitle,
    type RootSessionTitleClient,
} from "./root_session_title"

const DIRECTORY = "/repo"
const SESSION_ID = "leaf-session"
const MESSAGE_ID = "assistant-message"

type TitleHarness = {
    client: RootSessionTitleClient
    messages: ReturnType<typeof mock>
    get: ReturnType<typeof mock>
    update: ReturnType<typeof mock>
}

function createHarness(): TitleHarness {
    const messages = mock(async (): Promise<unknown> => ({ data: [] }))
    const get = mock(async (): Promise<unknown> => ({ data: { id: SESSION_ID, title: "Root session" } }))
    const update = mock(async (): Promise<unknown> => ({ data: {} }))
    return {
        client: { session: { messages, get, update } } as unknown as RootSessionTitleClient,
        messages,
        get,
        update,
    }
}

function fetchedMessage(
    agent: string = "assist",
    parts: unknown[] = [
        { type: "text", text: "# 🚀 Launch plan" },
        { type: "tool", messageID: MESSAGE_ID },
    ],
): unknown {
    return { info: { id: MESSAGE_ID, role: "assistant", agent }, parts }
}

function setFetchedMessages(harness: TitleHarness, data: unknown[]): void {
    harness.messages.mockImplementation(async (): Promise<unknown> => ({ data }))
}

function completedAssistantEvent(agent: string = "assist", finish?: string): Event {
    return {
        type: "message.updated",
        properties: {
            sessionID: SESSION_ID,
            info: {
                id: MESSAGE_ID,
                sessionID: SESSION_ID,
                role: "assistant",
                agent,
                time: { completed: 1 },
                ...(finish === undefined ? {} : { finish }),
            },
        },
    } as unknown as Event
}

function toolPartEvent(): Event {
    return {
        type: "message.part.updated",
        properties: { sessionID: SESSION_ID, part: { type: "tool", messageID: MESSAGE_ID } },
    } as unknown as Event
}

function toolCallsStepFinishEvent(): Event {
    return {
        type: "message.part.updated",
        properties: {
            sessionID: SESSION_ID,
            part: { type: "step-finish", reason: "tool-calls", messageID: MESSAGE_ID },
        },
    } as unknown as Event
}

function toolCallsStepEndedEvent(): Event {
    return {
        type: "session.next.step.ended",
        data: { sessionID: SESSION_ID, assistantMessageID: MESSAGE_ID, finish: "tool-calls" },
    } as unknown as Event
}

function expectRootTitleUpdate(harness: TitleHarness, title: string = "Root session (🚀 Launch plan)"): void {
    expect(harness.update).toHaveBeenCalledWith({
        path: { id: "root-session" },
        query: { directory: DIRECTORY },
        body: { title },
    })
}

function useRootSession(harness: TitleHarness, sessions: Record<string, unknown>): void {
    harness.get.mockImplementation(async ({ path }: { path: { id: string } }): Promise<unknown> => {
        const session = sessions[path.id]
        return session === undefined ? { error: "not found" } : { data: session }
    })
}

describe("parseRootSessionTitleHeading", () => {
    test("accepts a valid first heading", () => {
        expect(parseRootSessionTitleHeading("# 🚀 Launch plan")).toBe("🚀 Launch plan")
    })

    test("accepts a valid heading after leading blank lines", () => {
        expect(parseRootSessionTitleHeading("\n \n# 🚀 Launch plan")).toBe("🚀 Launch plan")
    })

    test("rejects a later heading when first eligible line is invalid", () => {
        expect(parseRootSessionTitleHeading("Intro text\n# 🚀 Launch plan")).toBeUndefined()
    })

    test.each([
        ["backtick", "```md\n# 🚀 Hidden title\n```"],
        ["tilde", "~~~md\n# 🚀 Hidden title\n~~~"],
    ])("excludes headings inside %s fences", (_name, text) => {
        expect(parseRootSessionTitleHeading(text)).toBeUndefined()
    })

    test.each([
        ["malformed H1", "## 🚀 Launch plan"],
        ["plain-word emoji", "# Launch plan"],
        ["blank title", "# 🚀    "],
    ])("rejects %s", (_name, text) => {
        expect(parseRootSessionTitleHeading(text)).toBeUndefined()
    })
})

describe("reconcileRootSessionTitle", () => {
    test("appends heading when title has no generated postfix", () => {
        expect(reconcileRootSessionTitle("Root session", "🚀 Launch plan")).toBe("Root session (🚀 Launch plan)")
    })

    test("replaces final generated postfix", () => {
        expect(reconcileRootSessionTitle("Root session (🧱 Old plan)", "🚀 Launch plan")).toBe("Root session (🚀 Launch plan)")
    })

    test("does not stack an identical generated postfix", () => {
        expect(reconcileRootSessionTitle("Root session (🚀 Launch plan)", "🚀 Launch plan")).toBe("Root session (🚀 Launch plan)")
    })

    test("preserves unrelated final parentheses", () => {
        expect(reconcileRootSessionTitle("Root session (critical issue)", "🚀 Launch plan")).toBe("Root session (critical issue) (🚀 Launch plan)")
    })
})

describe("createRootSessionTitleHook", () => {
    test("traverses multiple parent sessions and updates root title", async () => {
        const harness = createHarness()
        setFetchedMessages(harness, [fetchedMessage("advise")])
        useRootSession(harness, {
            [SESSION_ID]: { id: SESSION_ID, title: "Leaf", parentID: "middle-session" },
            "middle-session": { id: "middle-session", title: "Middle", parentID: "root-session" },
            "root-session": { id: "root-session", title: "Root session" },
        })

        await createRootSessionTitleHook(harness.client, DIRECTORY).handleEvent(completedAssistantEvent("advise"))

        expect(harness.get).toHaveBeenCalledTimes(3)
        expectRootTitleUpdate(harness)
    })

    test.each(["advise", "assist", "auto"])("accepts %s assistant turns", async (agent) => {
        const harness = createHarness()
        setFetchedMessages(harness, [fetchedMessage(agent)])
        useRootSession(harness, { [SESSION_ID]: { id: SESSION_ID, title: "Root session", parentID: "root-session" }, "root-session": { id: "root-session", title: "Root session" } })

        await createRootSessionTitleHook(harness.client, DIRECTORY).handleEvent(completedAssistantEvent(agent))

        expectRootTitleUpdate(harness)
    })

    test.each(["design", "other"])("rejects %s assistant turns", async (agent) => {
        const harness = createHarness()
        setFetchedMessages(harness, [fetchedMessage(agent)])

        await createRootSessionTitleHook(harness.client, DIRECTORY).handleEvent(completedAssistantEvent(agent))

        expect(harness.update).not.toHaveBeenCalled()
        expect(harness.get).not.toHaveBeenCalled()
    })

    test("updates once when tool event arrives before completed message becomes available", async () => {
        const harness = createHarness()
        useRootSession(harness, { [SESSION_ID]: { id: SESSION_ID, title: "Root session", parentID: "root-session" }, "root-session": { id: "root-session", title: "Root session" } })
        const hook = createRootSessionTitleHook(harness.client, DIRECTORY)

        await hook.handleEvent(toolPartEvent())
        setFetchedMessages(harness, [fetchedMessage()])
        await hook.handleEvent(completedAssistantEvent("assist", "tool-calls"))

        expect(harness.update).toHaveBeenCalledTimes(1)
        expectRootTitleUpdate(harness)
    })

    test("updates once when completed message arrives before tool parts become available", async () => {
        const harness = createHarness()
        useRootSession(harness, { [SESSION_ID]: { id: SESSION_ID, title: "Root session", parentID: "root-session" }, "root-session": { id: "root-session", title: "Root session" } })
        setFetchedMessages(harness, [fetchedMessage("assist", [{ type: "text", text: "# 🚀 Launch plan" }])])
        const hook = createRootSessionTitleHook(harness.client, DIRECTORY)

        await hook.handleEvent(completedAssistantEvent())
        setFetchedMessages(harness, [fetchedMessage()])
        await hook.handleEvent(toolPartEvent())

        expect(harness.update).toHaveBeenCalledTimes(1)
        expectRootTitleUpdate(harness)
    })

    test.each([
        ["tool part", toolPartEvent()],
        ["tool-calls step finish", toolCallsStepFinishEvent()],
        ["tool-calls step ended", toolCallsStepEndedEvent()],
    ])("handles %s event using fetched message text", async (_name, event) => {
        const harness = createHarness()
        setFetchedMessages(harness, [fetchedMessage("auto", [{ type: "text", text: "# 🚀 Launch plan" }])])
        useRootSession(harness, { [SESSION_ID]: { id: SESSION_ID, title: "Root session", parentID: "root-session" }, "root-session": { id: "root-session", title: "Root session" } })

        await createRootSessionTitleHook(harness.client, DIRECTORY).handleEvent(event)

        expectRootTitleUpdate(harness)
    })

    test.each([
        ["incomplete assistant message", { type: "message.updated", properties: { info: { id: MESSAGE_ID, sessionID: SESSION_ID, role: "assistant", agent: "assist", time: {} } } }],
        ["tool part without message ID", { type: "message.part.updated", properties: { sessionID: SESSION_ID, part: { type: "tool" } } }],
        ["step ended without tool calls", { type: "session.next.step.ended", data: { sessionID: SESSION_ID, assistantMessageID: MESSAGE_ID, finish: "stop" } }],
    ])("ignores partial %s", async (_name, value) => {
        const harness = createHarness()

        await createRootSessionTitleHook(harness.client, DIRECTORY).handleEvent(value as unknown as Event)

        expect(harness.messages).not.toHaveBeenCalled()
        expect(harness.update).not.toHaveBeenCalled()
    })

    test.each([
        ["missing target message", []],
        ["missing target parts", [{ info: { id: MESSAGE_ID, role: "assistant", agent: "assist" } }]],
    ])("does not update when fetched messages have %s", async (_name, data) => {
        const harness = createHarness()
        setFetchedMessages(harness, data)

        await createRootSessionTitleHook(harness.client, DIRECTORY).handleEvent(toolPartEvent())

        expect(harness.update).not.toHaveBeenCalled()
        expect(harness.get).not.toHaveBeenCalled()
    })

    test("swallows messages lookup failure", async () => {
        const harness = createHarness()
        harness.messages.mockImplementation(async (): Promise<never> => { throw new Error("messages unavailable") })

        await expect(createRootSessionTitleHook(harness.client, DIRECTORY).handleEvent(toolPartEvent())).resolves.toBeUndefined()

        expect(harness.update).not.toHaveBeenCalled()
    })

    test.each([
        ["failed parent traversal", { [SESSION_ID]: { id: SESSION_ID, title: "Leaf", parentID: "missing-parent" } }],
        ["parent cycle", { [SESSION_ID]: { id: SESSION_ID, title: "Leaf", parentID: "middle-session" }, "middle-session": { id: "middle-session", title: "Middle", parentID: SESSION_ID } }],
    ])("does not update after %s", async (_name, sessions) => {
        const harness = createHarness()
        setFetchedMessages(harness, [fetchedMessage()])
        useRootSession(harness, sessions)

        await createRootSessionTitleHook(harness.client, DIRECTORY).handleEvent(toolPartEvent())

        expect(harness.update).not.toHaveBeenCalled()
    })

    test("swallows session lookup rejection during parent traversal", async () => {
        const harness = createHarness()
        setFetchedMessages(harness, [fetchedMessage()])
        harness.get.mockImplementation(async ({ path }: { path: { id: string } }): Promise<unknown> => {
            if (path.id === SESSION_ID) return { data: { id: SESSION_ID, title: "Leaf", parentID: "root-session" } }
            throw new Error("session unavailable")
        })

        await expect(createRootSessionTitleHook(harness.client, DIRECTORY).handleEvent(toolPartEvent())).resolves.toBeUndefined()

        expect(harness.update).not.toHaveBeenCalled()
    })

    test("swallows root title update rejection", async () => {
        const harness = createHarness()
        setFetchedMessages(harness, [fetchedMessage()])
        useRootSession(harness, { [SESSION_ID]: { id: SESSION_ID, title: "Root session", parentID: "root-session" }, "root-session": { id: "root-session", title: "Root session" } })
        harness.update.mockImplementation(async (): Promise<never> => { throw new Error("update unavailable") })

        await expect(createRootSessionTitleHook(harness.client, DIRECTORY).handleEvent(toolPartEvent())).resolves.toBeUndefined()

        expectRootTitleUpdate(harness)
    })
})
