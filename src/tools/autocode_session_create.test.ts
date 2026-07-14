import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { ToolContext } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { getAgentTier } from "@/agents"
import type { ModelTier } from "@/config"
import { createAutocodeSessionCreateTool } from "./autocode_session_create"
import { createNoopAsk } from "./test_context"
import type { AutocodeSessionCreateAgent } from "@/utils/agent_swap"
import { resetRetryCounts } from "@/utils/tools"

type ExpectedModel = {
    providerID: string
    modelID: string
}

type ParsedToolResult = {
    agent?: string
    error?: string
    failedAction?: string
    instruction?: string
    [key: string]: unknown
}

const primaryAgentInstruction = "Provide agent as one of: assist, auto, research, design."

type PrimaryAgentTierCase = [AutocodeSessionCreateAgent, ModelTier, string]

const primaryAgentTierCases: PrimaryAgentTierCase[] = [
    ["assist", "balanced", "Handle the current task."],
    ["auto", "smart", "Continue execution."],
    ["design", "smart", "Update the design."],
    ["research", "smart", "Research the current risk."],
]

describe("autocode_session_create tool", () => {
    let xdgConfigHome: string | undefined
    let previousXdgConfigHome: string | undefined

    beforeEach(() => {
        resetRetryCounts()
        previousXdgConfigHome = process.env.XDG_CONFIG_HOME
        xdgConfigHome = mkdtempSync(join(tmpdir(), "autocode-config-home-"))
        process.env.XDG_CONFIG_HOME = xdgConfigHome
    })

    afterEach(() => {
        if (previousXdgConfigHome === undefined) {
            delete process.env.XDG_CONFIG_HOME
        } else {
            process.env.XDG_CONFIG_HOME = previousXdgConfigHome
        }

        if (xdgConfigHome) {
            rmSync(xdgConfigHome, { recursive: true, force: true })
        }
    })

    function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
        return {
            sessionID: "current-session",
            messageID: "message-1",
            agent: "pair",
            directory: "/workspace",
            worktree: "/workspace",
            abort: new AbortController().signal,
            metadata() {
            },
            ask: createNoopAsk(),
            ...overrides,
        }
    }

    function parseToolResult(result: string | { output: string }): ParsedToolResult {
        return JSON.parse(typeof result === "string" ? result : result.output)
    }

    function writeAutocodeTierConfig(worktree: string, autocodeConfig: Record<string, unknown>): void {
        mkdirSync(join(worktree, ".opencode"), { recursive: true })
        writeFileSync(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({ autocode: autocodeConfig }))
    }

    function createMockClient() {
        return {
            session: {
                create: mock(async (args: { query?: { directory?: string }, body?: { title?: string } }) => ({
                    data: {
                        id: "new-session",
                        projectID: "project-1",
                        directory: args.query?.directory,
                        title: args.body?.title,
                        version: "1",
                        time: { created: Date.now(), updated: Date.now() },
                    },
                })),
                promptAsync: mock(async () => ({})),
            },
        } as unknown as OpencodeClient & {
            session: {
                create: ReturnType<typeof mock>
                promptAsync: ReturnType<typeof mock>
            }
        }
    }

    function expectedModelForTier(tier: string | undefined): ExpectedModel {
        return tier === "balanced"
            ? { providerID: "anthropic", modelID: "claude-sonnet-4-5" }
            : { providerID: "openai", modelID: "gpt-5.5" }
    }

    test("creates a fresh session with trimmed prompt for the selected agent", async () => {
        const client = createMockClient()
        const prompt = `   ${"Swap to design and continue from the latest requirement set. ".repeat(2)}   `
        const trimmedPrompt = prompt.trim()
        const title = trimmedPrompt.slice(0, 60)
        const tool = createAutocodeSessionCreateTool(client)

        const parsed = parseToolResult(await tool.execute({ agent: "design", prompt }, createToolContext({ sessionID: "old-session" })))

        expect(client.session.create).toHaveBeenCalledWith({
            query: { directory: "/workspace" },
            body: { title },
        })
        expect(client.session.promptAsync).toHaveBeenCalledWith({
            path: { id: "new-session" },
            query: { directory: "/workspace" },
            body: {
                agent: "design",
                parts: [{ type: "text", text: trimmedPrompt }],
            },
        })
        expect(parsed).toEqual({
            session_id: "new-session",
            agent: "design",
            session_title: title,
            session_action: "created",
            message: `Created new session for design: ${title} (new-session).`,
        })
    })

    test.each(primaryAgentTierCases)("injects the %s primary agent %s tier model automatically", async (agent, expectedTier, prompt) => {
        const worktree = mkdtempSync(join(tmpdir(), "autocode-session-create-"))
        try {
            writeAutocodeTierConfig(worktree, {
                tiers: {
                    balanced: { model: "anthropic/claude-sonnet-4-5", variant: "standard" },
                    smart: { model: "openai/gpt-5.5", variant: "thinking" },
                },
            })

            const client = createMockClient()
            const tool = createAutocodeSessionCreateTool(client)
            const tier = getAgentTier(agent)

            expect(tier).toBe(expectedTier)

            await tool.execute({ agent, prompt }, createToolContext({ directory: worktree, worktree }))

            expect(client.session.create).toHaveBeenCalledWith({
                query: { directory: worktree },
                body: { title: prompt },
            })
            expect(client.session.promptAsync).toHaveBeenCalledWith({
                path: { id: "new-session" },
                query: { directory: worktree },
                body: {
                    agent,
                    model: expectedModelForTier(tier),
                    parts: [{ type: "text", text: prompt }],
                },
            })
        } finally {
            rmSync(worktree, { recursive: true, force: true })
        }
    })

    test("accepts only exact primary agents assist, auto, research, and design", async () => {
        const client = createMockClient()
        const tool = createAutocodeSessionCreateTool(client)

        const assistResult = parseToolResult(await tool.execute({ agent: "assist", prompt: "Handle the current task." }, createToolContext()))
        const autoResult = parseToolResult(await tool.execute({ agent: "auto", prompt: "Continue execution." }, createToolContext()))
        const researchResult = parseToolResult(await tool.execute({ agent: "research", prompt: "Research the current risk." }, createToolContext()))
        const designResult = parseToolResult(await tool.execute({ agent: "design", prompt: "Design the current change." }, createToolContext()))
        const uppercaseResult = parseToolResult(await tool.execute({ agent: "PLAN", prompt: "Update the plan." }, createToolContext()))
        const planResult = parseToolResult(await tool.execute({ agent: "plan", prompt: "Update the plan." }, createToolContext()))
        const hiddenWorkerResult = parseToolResult(await tool.execute({ agent: "hidden_worker", prompt: "Run a custom task." }, createToolContext()))
        const variantResult = parseToolResult(await tool.execute({ agent: "invalid-agent", prompt: "Continue execution." }, createToolContext()))
        const legacyActResult = parseToolResult(await tool.execute({ agent: "act", prompt: "Handle the current task." }, createToolContext()))
        const legacyAskResult = parseToolResult(await tool.execute({ agent: "ask", prompt: "Handle the current task." }, createToolContext()))

        expect(assistResult.agent).toBe("assist")
        expect(autoResult.agent).toBe("auto")
        expect(researchResult.agent).toBe("research")
        expect(designResult.agent).toBe("design")
        expect(uppercaseResult.failedAction).toBe("autocode_session_create")
        expect(uppercaseResult.error).toBe("Invalid agent: PLAN")
        expect(uppercaseResult.instruction).toBe(primaryAgentInstruction)
        expect(planResult.failedAction).toBe("autocode_session_create")
        expect(planResult.error).toBe("Invalid agent: plan")
        expect(planResult.instruction).toBe(primaryAgentInstruction)
        expect(hiddenWorkerResult.failedAction).toBe("autocode_session_create")
        expect(hiddenWorkerResult.error).toBe("Invalid agent: hidden_worker")
        expect(hiddenWorkerResult.instruction).toBe(primaryAgentInstruction)
        expect(variantResult.failedAction).toBe("autocode_session_create")
        expect(variantResult.error).toBe("Invalid agent: invalid-agent")
        expect(variantResult.instruction).toBe(primaryAgentInstruction)
        expect(legacyActResult.failedAction).toBe("autocode_session_create")
        expect(legacyActResult.error).toBe("Invalid agent: act")
        expect(legacyActResult.instruction).toBe(primaryAgentInstruction)
        expect(legacyAskResult.failedAction).toBe("autocode_session_create")
        expect(legacyAskResult.error).toBe("Invalid agent: ask")
        expect(typeof legacyAskResult.instruction).toBe("string")
        if (legacyAskResult.instruction?.includes("Provide agent")) {
            expect(legacyAskResult.instruction).toContain(primaryAgentInstruction)
        }
        expect(client.session.create).toHaveBeenCalledTimes(4)
        expect(client.session.promptAsync).toHaveBeenCalledTimes(4)
    })
})
