import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import type { Event, OpencodeClient } from "@opencode-ai/sdk"
import type { PrimaryAutocodeAgent } from "../utils/agent_swap"
import { createPendingAgentRestartCoordinator } from "../hooks/agent_restart_coordinator"
import { createAutocodeSessionRestartTool } from "./autocode_session_restart"
import { createNoopAsk } from "./test_context"

type ParsedToolResult = Record<string, unknown>
type AgentSchema = { safeParse(input: unknown): { success: boolean } }

const primaryAgents: PrimaryAutocodeAgent[] = ["assist", "advise", "auto", "design"]

describe("autocode_session_restart tool", () => {
    let worktree: string

    beforeEach(() => {
        worktree = mkdtempSync(join(tmpdir(), "autocode-session-restart-"))
        mkdirSync(join(worktree, ".opencode"), { recursive: true })
        writeFileSync(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({
            autocode: { tiers: { balanced: { model: "anthropic/claude-sonnet-4-5" }, smart: { model: "openai/gpt-5.5", variant: "thinking" } } },
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

    function idleEvent(): Event {
        return {
            type: "session.status",
            properties: { sessionID: "current-session", status: { type: "idle" } },
        } as unknown as Event
    }

    function createMockClient(): OpencodeClient & { session: { create: ReturnType<typeof mock>, summarize: ReturnType<typeof mock>, promptAsync: ReturnType<typeof mock> } } {
        return {
            session: {
                create: mock(async () => ({ data: { id: "new-session" } })),
                messages: mock(async () => ({ data: [{ info: { id: "user-1", role: "user", agent: "assist", time: { created: 1 } }, parts: [] }] })),
                summarize: mock(async () => ({ data: true })),
                promptAsync: mock(async () => ({})),
            },
        } as unknown as OpencodeClient & { session: { create: ReturnType<typeof mock>, summarize: ReturnType<typeof mock>, promptAsync: ReturnType<typeof mock> } }
    }

    function parseToolResult(result: string | { output: string }): ParsedToolResult {
        return JSON.parse(typeof result === "string" ? result : result.output)
    }

    test.each(primaryAgents)("returns pending restart for %s without compacting during tool execution", async (agent) => {
        const client = createMockClient()
        const coordinator = createPendingAgentRestartCoordinator()
        const tool = createAutocodeSessionRestartTool(client, coordinator)

        const parsed = parseToolResult(await tool.execute({ agent }, createToolContext()))

        expect(parsed).toEqual({
            session_id: "current-session",
            current_agent: "assist",
            target_agent: agent,
            compaction_pending: true,
            continuation_pending: true,
        })
        expect(client.session.summarize).not.toHaveBeenCalled()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(1)
        await coordinator.handleEvent(idleEvent())
        expect(client.session.summarize).toHaveBeenCalledTimes(1)
        expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
        expect(client.session.create).not.toHaveBeenCalled()
    })

    test("passes tool abort signal so an aborted request cannot execute after idle", async () => {
        const client = createMockClient()
        const coordinator = createPendingAgentRestartCoordinator()
        const controller = new AbortController()
        const tool = createAutocodeSessionRestartTool(client, coordinator)

        await tool.execute({ agent: "advise" }, createToolContext({ abort: controller.signal }))
        controller.abort()
        await coordinator.handleEvent(idleEvent())

        expect(client.session.summarize).not.toHaveBeenCalled()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
        expect(coordinator.pendingCount()).toBe(0)
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

    test("rejects unavailable lifecycle and invalid agent without compaction", async () => {
        const client = createMockClient()
        const missingLifecycle = createAutocodeSessionRestartTool(client)
        const activeTool = createAutocodeSessionRestartTool(client, createPendingAgentRestartCoordinator())

        const unavailable = parseToolResult(await missingLifecycle.execute({ agent: "auto" }, createToolContext()))
        const invalid = parseToolResult(await activeTool.execute({ agent: "plan" } as never, createToolContext()))

        expect(unavailable.failedAction).toBe("autocode_session_restart")
        expect(invalid.failedAction).toBe("validation")
        expect(client.session.summarize).not.toHaveBeenCalled()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })
})
