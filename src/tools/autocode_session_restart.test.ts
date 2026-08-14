import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import type { PrimaryAutocodeAgent } from "../utils/agent_swap"
import { createAutocodeSessionRestartTool } from "./autocode_session_restart"
import { createNoopAsk } from "./test_context"

type ParsedToolResult = Record<string, unknown>

type AgentSchema = {
    safeParse(input: unknown): { success: boolean }
}

const primaryAgents: PrimaryAutocodeAgent[] = ["assist", "advise", "auto", "design"]

describe("autocode_session_restart tool", () => {
    let worktree: string

    beforeEach(() => {
        worktree = mkdtempSync(join(tmpdir(), "autocode-session-restart-"))
        mkdirSync(join(worktree, ".opencode"), { recursive: true })
        writeFileSync(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({
            autocode: {
                tiers: {
                    balanced: { model: "anthropic/claude-sonnet-4-5" },
                    smart: { model: "openai/gpt-5.5", variant: "thinking" },
                },
            },
        }))
    })

    afterEach(() => {
        rmSync(worktree, { recursive: true, force: true })
    })

    function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
        return {
            sessionID: "current-session",
            messageID: "message-1",
            agent: "assist",
            directory: worktree,
            worktree,
            abort: new AbortController().signal,
            metadata() {
            },
            ask: createNoopAsk(),
            ...overrides,
        }
    }

    function createMockClient(): OpencodeClient & { session: { create: ReturnType<typeof mock>, summarize: ReturnType<typeof mock>, promptAsync: ReturnType<typeof mock> } } {
        return {
            session: {
                create: mock(async () => ({ data: { id: "new-session" } })),
                messages: mock(async () => ({
                    data: [{
                        info: { id: "user-1", role: "user", agent: "assist", time: { created: 1 } },
                        parts: [],
                    }],
                })),
                summarize: mock(async () => ({ data: true })),
                promptAsync: mock(async () => ({})),
            },
        } as unknown as OpencodeClient & { session: { create: ReturnType<typeof mock>, summarize: ReturnType<typeof mock>, promptAsync: ReturnType<typeof mock> } }
    }

    function parseToolResult(result: string | { output: string }): ParsedToolResult {
        return JSON.parse(typeof result === "string" ? result : result.output)
    }

    test.each(primaryAgents)("restarts %s in the current session without creating one", async (agent) => {
        const client = createMockClient()
        client.session.summarize.mockImplementation(async function (this: unknown) {
            expect(this).toBe(client.session)
            return { data: true }
        })
        const tool = createAutocodeSessionRestartTool(client)

        const parsed = parseToolResult(await tool.execute({ agent }, createToolContext()))

        expect(parsed).toEqual({
            session_id: "current-session",
            current_agent: "assist",
            target_agent: agent,
            compaction_completed: true,
            continuation_dispatched: true,
        })
        expect(client.session.summarize).toHaveBeenCalledWith({
            path: { id: "current-session" },
            query: { directory: worktree },
            body: expect.objectContaining({ auto: false }),
        })
        expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
            path: { id: "current-session" },
            query: { directory: worktree },
            body: expect.objectContaining({ agent }),
        }))
        expect(client.session.create).not.toHaveBeenCalled()
    })

    test("schema exposes only agent and omits legacy create fields", () => {
        const tool = createAutocodeSessionRestartTool()
        const agentSchema = tool.args.agent as unknown as AgentSchema

        expect(Object.keys(tool.args)).toEqual(["agent"])
        for (const legacyCreateField of ["model", "auto", "prompt", "title"] as const) {
            expect(tool.args).not.toHaveProperty(legacyCreateField)
        }
        for (const agent of primaryAgents) {
            expect(agentSchema.safeParse(agent).success).toBe(true)
        }
    })

    test("rejects missing and invalid agent schema inputs", () => {
        const tool = createAutocodeSessionRestartTool()
        const agentSchema = tool.args.agent as unknown as AgentSchema

        expect(agentSchema.safeParse(undefined).success).toBe(false)
        expect(agentSchema.safeParse("plan").success).toBe(false)
    })

    test("rejects missing and invalid agents without creating a session", async () => {
        const client = createMockClient()
        const tool = createAutocodeSessionRestartTool(client)

        const missing = parseToolResult(await tool.execute({} as never, createToolContext()))
        const invalid = parseToolResult(await tool.execute({ agent: "plan" } as never, createToolContext()))

        expect(missing.failedAction).toBe("validation")
        expect(invalid.failedAction).toBe("validation")
        expect(client.session.create).not.toHaveBeenCalled()
        expect(client.session.summarize).not.toHaveBeenCalled()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })

    test("ignores legacy extra inputs while restarting the current session", async () => {
        const client = createMockClient()
        const tool = createAutocodeSessionRestartTool(client)

        const parsed = parseToolResult(await tool.execute({
            agent: "auto",
            model: "openai/gpt-5.5",
            auto: true,
            prompt: "Create another session",
            title: "Separate Session",
            unknown: "ignored",
        } as never, createToolContext()))

        expect(parsed.session_id).toBe("current-session")
        expect(parsed.target_agent).toBe("auto")
        expect(client.session.create).not.toHaveBeenCalled()
    })
})
