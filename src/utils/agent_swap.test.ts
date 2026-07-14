import { describe, expect, mock, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createAutocodeAgentPreviousSkippedResponse, createAutocodeAgentSwapSuccessResponse, createAutocodeSession, createAutocodeSessionCreateSuccessResponse, createAutocodeSessionPrompt, deriveAutocodeAgentSwapTitle, dispatchAutocodeAgentPrompt, findPreviousPrimaryAutocodeAgent, formatAutocodeSessionTitleForAgent, resolveTierModel, swapCurrentAutocodeSession, validateAutocodeAgentSwapInput, validateAutocodeSessionCreateInput } from "./agent_swap"

function createClient() {
    return {
        session: {
            create: mock(async (args: { body?: { title?: string } }) => ({
                data: {
                    id: `session-for-${args.body?.title}`,
                },
            })),
            update: mock(async () => ({ data: { id: "session-1" } })),
            promptAsync: mock(async () => ({})),
        },
    } as unknown as OpencodeClient & {
        session: {
            create: ReturnType<typeof mock>
            update: ReturnType<typeof mock>
            promptAsync: ReturnType<typeof mock>
        }
    }
}

function createSessionMessage(agent: string, created: number) {
    return {
        info: {
            id: `${agent}-${created}`,
            role: "assistant",
            agent,
            time: { created },
        },
        parts: [],
    }
}

function createMessagesClient(messages: ReturnType<typeof createSessionMessage>[]) {
    return {
        session: {
            messages: mock(async () => ({ data: messages })),
        },
    } as Parameters<typeof findPreviousPrimaryAutocodeAgent>[0] & {
        session: {
            messages: ReturnType<typeof mock>
        }
    }
}

describe("agent swap utilities", () => {
    test("derives session titles from the first sixty prompt characters", () => {
        expect(deriveAutocodeAgentSwapTitle("short prompt")).toBe("short prompt")
        expect(deriveAutocodeAgentSwapTitle("x".repeat(80))).toBe("x".repeat(60))
    })

    test("formats session title with agent postfix, stripping any prior single-word paren postfix", () => {
        expect(formatAutocodeSessionTitleForAgent("Create login screen", "design")).toBe("Create login screen (design)")
        expect(formatAutocodeSessionTitleForAgent("Some title (executing)", "design")).toBe("Some title (design)")
        expect(formatAutocodeSessionTitleForAgent("Some title (research)", "design")).toBe("Some title (design)")
        expect(formatAutocodeSessionTitleForAgent("Some title (design) ", "research")).toBe("Some title (research)")
        expect(formatAutocodeSessionTitleForAgent("Fix (critical issue)", "design")).toBe("Fix (critical issue) (design)")
    })

    test("validates and trims prompt and agent values", () => {
        expect(validateAutocodeAgentSwapInput("  Continue the task.  ", " made-up-agent ")).toEqual({
            prompt: "Continue the task.",
            agent: "made-up-agent",
            title: "Continue the task.",
        })
        expect(validateAutocodeAgentSwapInput("   ", "plan")).toEqual({
            error: "Missing or invalid prompt",
            instruction: "Provide a nonblank string prompt.",
        })
        expect(validateAutocodeAgentSwapInput("  Continue the task.  ", " assist ")).toEqual({
            prompt: "Continue the task.",
            agent: "assist",
            title: "Continue the task.",
        })
        expect(validateAutocodeAgentSwapInput("  Run a custom task.  ", " hidden_worker ")).toEqual({
            prompt: "Run a custom task.",
            agent: "hidden_worker",
            title: "Run a custom task.",
        })
        expect(validateAutocodeAgentSwapInput("Continue the task.", "   ")).toEqual({
            error: "Invalid agent:    ",
            instruction: "Provide a non-blank agent name.",
        })
        expect(validateAutocodeAgentSwapInput("Continue the task.", null)).toEqual({
            error: "Invalid agent: null",
            instruction: "Provide a non-blank agent name.",
        })
    })

    test("validates session creation with primary agents only", () => {
        expect(validateAutocodeSessionCreateInput("  Continue the task.  ", " auto ")).toEqual({
            prompt: "Continue the task.",
            agent: "auto",
            title: "Continue the task.",
        })
        expect(validateAutocodeSessionCreateInput("Continue the task.", "hidden_worker")).toEqual({
            error: "Invalid agent: hidden_worker",
            instruction: "Provide agent as one of: assist, auto, research, design.",
        })
        expect(validateAutocodeSessionCreateInput("Continue the task.", "invalid-agent")).toEqual({
            error: "Invalid agent: invalid-agent",
            instruction: "Provide agent as one of: assist, auto, research, design.",
        })
    })

    test("creates a fresh session and returns its id", async () => {
        const client = createClient()

        const created = await createAutocodeSession(client, "/workspace", "Plan Title", "auto")

        expect(client.session.create).toHaveBeenCalledWith({
            query: { directory: "/workspace" },
            body: { title: "Plan Title" },
        })
        expect(created).toEqual({ sessionID: "session-for-Plan Title" })
    })

    test("dispatches prompt text to the selected existing session", async () => {
        const client = createClient()

        const dispatched = await dispatchAutocodeAgentPrompt(client, "/workspace", "ses_123", "auto", "Continue execution.", {
            model: { providerID: "openai", modelID: "gpt-5.5" },
            variant: "thinking",
        })

        expect(client.session.promptAsync).toHaveBeenCalledWith({
            path: { id: "ses_123" },
            query: { directory: "/workspace" },
            body: {
                agent: "auto",
                model: { providerID: "openai", modelID: "gpt-5.5" },
                parts: [{ type: "text", text: "Continue execution." }],
            },
        })
        expect(dispatched).toEqual({ sessionID: "ses_123" })
    })

    test("resolves provider, model, and variant from tier config", () => {
        expect(resolveTierModel("smart", {
            smart: { model: "openai/gpt-5.5", variant: "thinking" },
        })).toEqual({
            model: { providerID: "openai", modelID: "gpt-5.5" },
            variant: "thinking",
        })
        expect(resolveTierModel("smart", {
            smart: { model: "missing-slash" },
        })).toEqual({})
        expect(resolveTierModel("balanced", {
            balanced: { model: "anthropic/claude-sonnet-4-5", variant: "standard" },
        })).toEqual({
            model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
            variant: undefined,
        })
    })

    test("swaps an existing session without updating the session title", async () => {
        const client = createClient()

        const swapped = await swapCurrentAutocodeSession(client, "/workspace", "ses_123", "auto", "Continue execution.")

        expect(client.session.update).not.toHaveBeenCalled()
        expect(client.session.promptAsync).toHaveBeenCalledWith({
            path: { id: "ses_123" },
            query: { directory: "/workspace" },
            body: {
                agent: "auto",
                parts: [{ type: "text", text: "Continue execution." }],
            },
        })
        expect(swapped).toEqual({ sessionID: "ses_123" })
    })

    test("creates the fresh session before dispatching the agent prompt", async () => {
        const client = createClient()

        const handoff = await createAutocodeSessionPrompt(client, "/workspace", "assist", "Continue the task.", "Task Title")

        expect(client.session.create).toHaveBeenCalledTimes(1)
        expect(client.session.promptAsync).toHaveBeenCalledWith({
            path: { id: "session-for-Task Title" },
            query: { directory: "/workspace" },
            body: {
                agent: "assist",
                parts: [{ type: "text", text: "Continue the task." }],
            },
        })
        expect(handoff).toEqual({ sessionID: "session-for-Task Title" })
    })

    test("returns exact new-session success response fields and message", () => {
        expect(JSON.parse(createAutocodeSessionCreateSuccessResponse("auto", "Task Title", "session-1"))).toEqual({
            session_id: "session-1",
            agent: "auto",
            session_title: "Task Title",
            session_action: "created",
            message: "Created new session for auto: Task Title (session-1).",
        })
    })

    test("returns exact same-session swap response fields and message", () => {
        expect(JSON.parse(createAutocodeAgentSwapSuccessResponse("auto", "session-1"))).toEqual({
            session_id: "session-1",
            agent: "auto",
            session_action: "swapped",
            message: "Swapped current session to auto (session-1).",
        })
    })

    test("returns exact skipped previous-primary response fields and message", () => {
        expect(JSON.parse(createAutocodeAgentPreviousSkippedResponse("session-1", "No previous primary agent found in current session history."))).toEqual({
            session_id: "session-1",
            skipped: true,
            reason: "No previous primary agent found in current session history.",
            message: "Skipped previous-primary handoff for current session (session-1): No previous primary agent found in current session history.",
        })
    })

    test("finds newest primary autocode agent after sorting newest-first and skipping non-primary agents", async () => {
        const client = createMessagesClient([
            createSessionMessage("assist", 10),
            createSessionMessage("pair", 90),
            createSessionMessage("design", 70),
            createSessionMessage("hidden_worker", 100),
            createSessionMessage("research", 80),
        ])

        const result = await findPreviousPrimaryAutocodeAgent(client, "/workspace", "session-1")

        expect(result).toEqual({
            agent: "research",
            skipped: false,
        })
    })

    test("skips current primary agent while scanning session history", async () => {
        const client = createMessagesClient([
            createSessionMessage("design", 100),
            createSessionMessage("pair", 90),
            createSessionMessage("assist", 80),
        ])

        const result = await findPreviousPrimaryAutocodeAgent(client, "/workspace", "session-1", "design")

        expect(result).toEqual({
            agent: "assist",
            skipped: false,
        })
    })

    test("returns skipped result with unresolved reason when no eligible previous primary agent exists", async () => {
        const client = createMessagesClient([
            createSessionMessage("design", 100),
            createSessionMessage("pair", 90),
            createSessionMessage("hidden_worker", 80),
            createSessionMessage("design", 70),
        ])

        const result = await findPreviousPrimaryAutocodeAgent(client, "/workspace", "session-1", "design")

        expect(result).toEqual({
            skipped: true,
            reason: "No previous primary agent found in current session history.",
        })
    })
})
