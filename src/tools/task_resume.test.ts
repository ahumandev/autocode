import { describe, expect, mock, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createTaskResumeTool } from "./task_resume"
import { createNoopAsk } from "./test_context"
import { createAbortResponse } from "@/utils/tools"

function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        sessionID: "parent-session",
        messageID: "message-1",
        agent: "auto",
        directory: "/workspace",
        worktree: "/workspace",
        abort: new AbortController().signal,
        metadata() {},
        ask: createNoopAsk(),
        ...overrides,
    }
}

function createSession(id: string, overrides: Record<string, unknown> = {}): any {
    return {
        id,
        directory: "/workspace",
        projectID: "project-1",
        title: id,
        version: "1",
        time: { created: 1000, updated: 2000 },
        permission: { task: "allow" },
        ...overrides,
    }
}

function createAssistantMessage(id: string, interrupted = true): any {
    return {
        id,
        role: "assistant",
        sessionID: "child-session",
        providerID: "anthropic",
        modelID: "claude-3",
        time: {
            created: 1000,
            completed: interrupted ? undefined : 2000,
        },
        error: interrupted ? { name: "MessageAbortedError", data: {} } : undefined,
    }
}

function createUserMessage(id: string, text: string): any {
    return {
        info: {
            id,
            role: "user",
            sessionID: "child-session",
            time: { created: 900 },
        },
        parts: [
            {
                type: "text",
                text,
                messageID: id,
            },
        ],
    }
}

function createInterruptedChildMessages(promptText: string): any[] {
    const assistantMsg = createAssistantMessage("assist-1", true)
    return [
        createUserMessage("user-1", promptText),
        {
            info: assistantMsg,
            parts: [],
        },
    ]
}

function createNonInterruptedChildMessages(promptText: string): any[] {
    return [
        createUserMessage("user-1", promptText),
        {
            info: {
                id: "assist-1",
                role: "assistant",
                sessionID: "child-session",
                providerID: "anthropic",
                modelID: "claude-3",
                time: { created: 1000, completed: 2000 },
            },
            parts: [],
        },
    ]
}

function createParentMessages(taskId: string, promptText: string): any[] {
    return [
        {
            info: {
                id: "parent-msg-1",
                role: "user",
                sessionID: "parent-session",
                time: { created: 800 },
            },
            parts: [
                {
                    type: "tool",
                    tool: "task",
                    messageID: "parent-msg-1",
                    state: {
                        status: "completed",
                        input: { task_id: taskId, prompt: promptText },
                        time: { start: 1000, end: 2000 },
                    },
                },
            ],
        },
    ]
}

function createMockClient(overrides: {
    sessionGetData?: any
    sessionGetError?: any
    parentMessages?: any[]
    childSessions?: any[]
    childMessagesMap?: Record<string, any[]>
    promptAsyncError?: any
} = {}): OpencodeClient {
    const {
        sessionGetData = createSession("parent-session"),
        sessionGetError,
        parentMessages = [],
        childSessions = [],
        childMessagesMap = {},
        promptAsyncError,
    } = overrides

    const client = {
        session: {
            get: mock(async () => ({
                data: sessionGetError ? undefined : sessionGetData,
                error: sessionGetError,
            })),
            messages: mock(async (args: any) => {
                const sessionId = args.path.id
                if (sessionId === "parent-session") {
                    return { data: parentMessages, error: undefined }
                }
                const messages = childMessagesMap[sessionId]
                if (messages === undefined) {
                    return { data: [], error: undefined }
                }
                return { data: messages, error: undefined }
            }),
            children: mock(async () => ({
                data: childSessions,
                error: undefined,
            })),
            promptAsync: mock(async () => ({
                error: promptAsyncError,
            })),
        },
    } as unknown as OpencodeClient

    return client
}

describe("task_resume tool", () => {
    test("returns abort response when current session cannot be fetched", async () => {
        const client = createMockClient({
            sessionGetError: { name: "NotFound", message: "session not found" },
        })
        const tool = createTaskResumeTool(client)

        const result = await tool.execute({}, createToolContext())

        expect(result).toBe(
            createAbortResponse("inspect current session", { name: "NotFound", message: "session not found" })
        )
    })

    test("returns 'no interrupted descendants found' when no children exist (no-arg fallback)", async () => {
        const client = createMockClient({
            childSessions: [],
        })
        const tool = createTaskResumeTool(client)

        const result = await tool.execute({}, createToolContext())

        expect(result).toBe("No interrupted descendants found.")
    })

    test("no-arg fallback: resumes interrupted child sessions and reports session IDs", async () => {
        const childSession = createSession("child-session-1")
        const childMessages = createInterruptedChildMessages("Do the work")

        const client = createMockClient({
            childSessions: [childSession],
            childMessagesMap: {
                "child-session-1": childMessages,
            },
        })
        const tool = createTaskResumeTool(client)

        const result = await tool.execute({}, createToolContext())

        expect(result).toContain("child-session-1")
        expect(result).toContain("You can now resume your own work.")
        expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    })

    test("no-arg fallback: returns 'no interrupted descendants' when child is not interrupted", async () => {
        const childSession = createSession("child-session-1")
        const childMessages = createNonInterruptedChildMessages("Do the work")

        const client = createMockClient({
            childSessions: [childSession],
            childMessagesMap: {
                "child-session-1": childMessages,
            },
        })
        const tool = createTaskResumeTool(client)

        const result = await tool.execute({}, createToolContext())

        expect(result).toBe("No interrupted descendants found.")
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })

    test("task_id resume success: resumes specific interrupted session and reports success", async () => {
        const promptText = "Do the specific work"
        const taskId = "known-task-id"
        const childSession = createSession("child-session-1")
        const parentMessages = createParentMessages(taskId, promptText)
        const childMessages = createInterruptedChildMessages(promptText)

        const client = createMockClient({
            parentMessages,
            childSessions: [childSession],
            childMessagesMap: {
                "child-session-1": childMessages,
            },
        })
        const tool = createTaskResumeTool(client)

        const result = await tool.execute({ task_id: taskId }, createToolContext())

        expect(result).toBe(`Resumed session for task_id '${taskId}'. You can now resume your own work.`)
        expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    })

    test("task_id not interrupted: returns non-destructive message when session exists but is not interrupted", async () => {
        const promptText = "Do the non-interrupted work"
        const taskId = "known-task-id"
        const childSession = createSession("child-session-1")
        const parentMessages = createParentMessages(taskId, promptText)
        const childMessages = createNonInterruptedChildMessages(promptText)

        const client = createMockClient({
            parentMessages,
            childSessions: [childSession],
            childMessagesMap: {
                "child-session-1": childMessages,
            },
        })
        const tool = createTaskResumeTool(client)

        const result = await tool.execute({ task_id: taskId }, createToolContext())

        expect(result).toBe(`Task ID '${taskId}' is resolved to session 'child-session-1' but it is not interrupted.`)
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })

    test("task_id unknown: returns 'could not be resolved' message for unknown task_id", async () => {
        const client = createMockClient({
            childSessions: [],
        })
        const tool = createTaskResumeTool(client)

        const result = await tool.execute({ task_id: "unknown-task-id" }, createToolContext())

        expect(result).toBe("Task ID 'unknown-task-id' could not be resolved to a session.")
    })

    test("task_id unknown: returns 'could not be resolved' when children exist but none match the task_id", async () => {
        const childSession = createSession("child-session-1")
        const childMessages = createInterruptedChildMessages("some other work")

        const client = createMockClient({
            parentMessages: [],
            childSessions: [childSession],
            childMessagesMap: {
                "child-session-1": childMessages,
            },
        })
        const tool = createTaskResumeTool(client)

        const result = await tool.execute({ task_id: "missing-task-id" }, createToolContext())

        expect(result).toBe("Task ID 'missing-task-id' could not be resolved to a session.")
    })

    test("stale/unavailable session: returns retry response when children API throws", async () => {
        const client = {
            session: {
                get: mock(async () => ({
                    data: createSession("parent-session"),
                    error: undefined,
                })),
                messages: mock(async (args: any) => {
                    if (args.path.id === "parent-session") {
                        return { data: [], error: undefined }
                    }
                    throw new Error("session unavailable")
                }),
                children: mock(async () => {
                    throw new Error("children unavailable")
                }),
                promptAsync: mock(async () => ({ error: undefined })),
            },
        } as unknown as OpencodeClient

        const tool = createTaskResumeTool(client)
        const result = await tool.execute({}, createToolContext())

        const parsed = JSON.parse(result as string)
        expect(parsed.failedAction).toBe("resume interrupted descendants")
        expect(parsed.error).toContain("children unavailable")
    })

    test("stale/unavailable session: returns retry response when messages API fails for child", async () => {
        const childSession = createSession("child-session-1")

        const client = {
            session: {
                get: mock(async () => ({
                    data: createSession("parent-session"),
                    error: undefined,
                })),
                messages: mock(async (args: any) => {
                    if (args.path.id === "parent-session") {
                        return { data: [], error: undefined }
                    }
                    return { data: undefined, error: { name: "Error", message: "unavailable" } }
                }),
                children: mock(async () => ({
                    data: [childSession],
                    error: undefined,
                })),
                promptAsync: mock(async () => ({ error: undefined })),
            },
        } as unknown as OpencodeClient

        const tool = createTaskResumeTool(client)
        const result = await tool.execute({}, createToolContext())

        const parsed = JSON.parse(result as string)
        expect(parsed.failedAction).toBe("resume interrupted descendants")
        expect(parsed.error).toContain("child-session-1")
    })

    test("permission/SDK error: returns retry response when promptAsync returns error", async () => {
        const childSession = createSession("child-session-1")
        const childMessages = createInterruptedChildMessages("Do the work")

        const client = createMockClient({
            childSessions: [childSession],
            childMessagesMap: {
                "child-session-1": childMessages,
            },
            promptAsyncError: { name: "PermissionDenied", message: "not allowed" },
        })
        const tool = createTaskResumeTool(client)

        const result = await tool.execute({}, createToolContext())

        const parsed = JSON.parse(result as string)
        expect(parsed.failedAction).toBe("resume interrupted descendants")
        expect(parsed.error).toContain("child-session-1")
    })

    test("no-arg fallback: resumes multiple interrupted sessions and reports count", async () => {
        const child1 = createSession("child-session-1")
        const child2 = createSession("child-session-2")
        const childMessages1 = createInterruptedChildMessages("Do work 1")
        const childMessages2 = createInterruptedChildMessages("Do work 2")

        const client = createMockClient({
            childSessions: [child1, child2],
            childMessagesMap: {
                "child-session-1": childMessages1,
                "child-session-2": childMessages2,
            },
        })
        const tool = createTaskResumeTool(client)

        const result = await tool.execute({}, createToolContext())

        expect(result).toContain("Resumed 2 sessions:")
        expect(result).toContain("You can now resume your own work.")
        expect(client.session.promptAsync).toHaveBeenCalledTimes(2)
    })

    test("outer exception: returns abort response when client.session.get throws", async () => {
        const client = {
            session: {
                get: mock(async () => {
                    throw new Error("network failure")
                }),
            },
        } as unknown as OpencodeClient

        const tool = createTaskResumeTool(client)
        const result = await tool.execute({}, createToolContext())

        expect(result).toBe(createAbortResponse("resume interrupted descendants", new Error("network failure")))
    })
})
