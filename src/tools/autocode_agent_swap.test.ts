import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { ToolContext } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { getAgentTier } from "@/agents"
import type { ModelTier } from "@/config"
import { createAutocodeAgentSwapTool } from "./autocode_agent_swap"
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

type PrimaryAgentTierCase = [AutocodeSessionCreateAgent, ModelTier, string]

const primaryAgentTierCases: PrimaryAgentTierCase[] = [
    ["assist", "balanced", "Handle the current task."],
    ["auto", "smart", "Continue execution."],
    ["design", "smart", "Update the design."],
    ["research", "smart", "Research the current risk."],
]

describe("autocode_agent_swap tool", () => {
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
                update: mock(async () => ({ data: { id: "current-session" } })),
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

    function expectedModelForTier(tier: string | undefined): ExpectedModel {
        return tier === "balanced"
            ? { providerID: "anthropic", modelID: "claude-sonnet-4-5" }
            : { providerID: "openai", modelID: "gpt-5.5" }
    }

    test("swaps the current session with the supplied prompt for the selected agent", async () => {
        const client = createMockClient()
        const prompt = `   ${"Swap to design and continue from the latest requirement set. ".repeat(2)}   `
        const trimmedPrompt = prompt.trim()
        const tool = createAutocodeAgentSwapTool(client)

        const parsed = parseToolResult(await tool.execute({ agent: "design", prompt }, createToolContext({ sessionID: "old-session" })))

        expect(client.session.update).not.toHaveBeenCalled()
        expect(client.session.promptAsync).toHaveBeenCalledWith({
            path: { id: "old-session" },
            query: { directory: "/workspace" },
            body: {
                agent: "design",
                parts: [{ type: "text", text: trimmedPrompt }],
            },
        })
        expect(client.session.create).not.toHaveBeenCalled()
        expect(parsed).toEqual({
            session_id: "old-session",
            agent: "design",
            session_action: "swapped",
            message: "Swapped current session to design (old-session).",
        })
    })

    test.each(primaryAgentTierCases)("injects the %s primary agent %s tier model automatically", async (agent, expectedTier, prompt) => {
        const worktree = mkdtempSync(join(tmpdir(), "autocode-agent-swap-"))
        try {
            writeAutocodeTierConfig(worktree, {
                tiers: {
                    balanced: { model: "anthropic/claude-sonnet-4-5", variant: "standard" },
                    smart: { model: "openai/gpt-5.5", variant: "thinking" },
                },
            })

            const client = createMockClient()
            const tool = createAutocodeAgentSwapTool(client)
            const tier = getAgentTier(agent)

            expect(tier).toBe(expectedTier)

            await tool.execute({ agent, prompt }, createToolContext({ directory: worktree, worktree, sessionID: "old-session" }))

            expect(client.session.update).not.toHaveBeenCalled()
            expect(client.session.promptAsync).toHaveBeenCalledWith({
                path: { id: "old-session" },
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

    test("falls back safely when the swapped agent tier has no configured model", async () => {
        const worktree = mkdtempSync(join(tmpdir(), "autocode-agent-swap-"))
        try {
            writeAutocodeTierConfig(worktree, {
                tiers: {
                    balanced: { model: "anthropic/claude-sonnet-4-5", variant: "standard" },
                },
            })

            const client = createMockClient()
            const tool = createAutocodeAgentSwapTool(client)

            await tool.execute({ agent: "auto", prompt: "Continue execution." }, createToolContext({ directory: worktree, worktree, sessionID: "old-session" }))

            expect(client.session.update).not.toHaveBeenCalled()
            expect(client.session.promptAsync).toHaveBeenCalledWith({
                path: { id: "old-session" },
                query: { directory: worktree },
                body: {
                agent: "auto",
                parts: [{ type: "text", text: "Continue execution." }],
                },
            })
        } finally {
            rmSync(worktree, { recursive: true, force: true })
        }
    })

    test("accepts arbitrary nonblank agent names", async () => {
        const client = createMockClient()
        const tool = createAutocodeAgentSwapTool(client)

        const tempReportResult = parseToolResult(await tool.execute({ agent: " temp_report ", prompt: "Write a hidden report." }, createToolContext()))
        const madeUpResult = parseToolResult(await tool.execute({ agent: " made-up-agent ", prompt: "Continue execution." }, createToolContext()))

        expect(tempReportResult.agent).toBe("temp_report")
        expect(madeUpResult.agent).toBe("made-up-agent")
        expect(client.session.update).not.toHaveBeenCalled()
        expect(client.session.promptAsync).toHaveBeenCalledTimes(2)
        expect(client.session.promptAsync).toHaveBeenNthCalledWith(1, {
            path: { id: "current-session" },
            query: { directory: "/workspace" },
            body: {
                agent: "temp_report",
                parts: [{ type: "text", text: "Write a hidden report." }],
            },
        })
        expect(client.session.promptAsync).toHaveBeenNthCalledWith(2, {
            path: { id: "current-session" },
            query: { directory: "/workspace" },
            body: {
                agent: "made-up-agent",
                parts: [{ type: "text", text: "Continue execution." }],
            },
        })
        expect(client.session.create).not.toHaveBeenCalled()
    })

    test("passes exact temp_report swap agent to promptAsync", async () => {
        const client = createMockClient()
        const tool = createAutocodeAgentSwapTool(client)

        const parsed = parseToolResult(await tool.execute({ agent: "temp_report", prompt: "Prepare a temporary report." }, createToolContext({ sessionID: "old-session" })))

        expect(client.session.promptAsync).toHaveBeenCalledWith({
            path: { id: "old-session" },
            query: { directory: "/workspace" },
            body: {
                agent: "temp_report",
                parts: [{ type: "text", text: "Prepare a temporary report." }],
            },
        })
        expect(parsed.agent).toBe("temp_report")
        expect(client.session.create).not.toHaveBeenCalled()
    })

    test("aborts when the SDK client is unavailable", async () => {
        const tool = createAutocodeAgentSwapTool()

        const parsed = parseToolResult(await tool.execute({ agent: "design", prompt: "Continue with the current design." }, createToolContext()))

        expect(parsed.failedAction).toBe("autocode_agent_swap")
        expect(parsed.error).toBe("Unable to swap current session: client is unavailable")
        expect(parsed.instruction).toContain("Immediately ABORT your flow")
    })

    test("aborts when prompting the current session fails", async () => {
        const client = createMockClient()
        client.session.promptAsync.mockImplementationOnce(async () => ({ error: "prompt failed" }))
        const tool = createAutocodeAgentSwapTool(client)

        const parsed = parseToolResult(await tool.execute({ agent: "auto", prompt: "Continue execution." }, createToolContext()))

        expect(parsed.failedAction).toBe("autocode_agent_swap")
        expect(parsed.error).toBe("Autocode session API failed (stage=prompt_dispatch, directory=/workspace, session/title=current-session, agent=auto): prompt failed")
        expect(parsed.instruction).toContain("Immediately ABORT your flow")
        expect(client.session.create).not.toHaveBeenCalled()
    })

    test("does not abort when current session title update would fail", async () => {
        const client = createMockClient()
        client.session.update.mockImplementationOnce(async () => ({ error: "session update failed" }))
        const tool = createAutocodeAgentSwapTool(client)

        const parsed = parseToolResult(await tool.execute({ agent: "design", prompt: "Update the design." }, createToolContext()))

        expect(parsed).toEqual({
            session_id: "current-session",
            agent: "design",
            session_action: "swapped",
            message: "Swapped current session to design (current-session).",
        })
        expect(client.session.update).not.toHaveBeenCalled()
        expect(client.session.promptAsync).toHaveBeenCalled()
    })

    test("aborts when the same-session swap throws", async () => {
        const client = createMockClient()
        client.session.promptAsync.mockImplementationOnce(async () => { throw new Error("network down") })
        const tool = createAutocodeAgentSwapTool(client)

        const parsed = parseToolResult(await tool.execute({ agent: "auto", prompt: "Continue execution." }, createToolContext()))

        expect(client.session.promptAsync).toHaveBeenCalled()
        expect(client.session.create).not.toHaveBeenCalled()
        expect(parsed.failedAction).toBe("autocode_agent_swap")
        expect(parsed.error).toBe("Autocode session API failed (stage=prompt_dispatch, directory=/workspace, session/title=current-session, agent=auto): network down")
        expect(parsed.instruction).toContain("Immediately ABORT your flow")
    })

    test("retries with guidance when prompt is omitted", async () => {
        const client = createMockClient()
        const tool = createAutocodeAgentSwapTool(client)

        const parsed = parseToolResult(await tool.execute({ agent: "auto" } as never, createToolContext()))

        expect(parsed.failedAction).toBe("autocode_agent_swap")
        expect(parsed.error).toBe("Missing or invalid prompt")
        expect(parsed.instruction).toContain("Provide a nonblank string prompt")
        expect(client.session.create).not.toHaveBeenCalled()
        expect(client.session.update).not.toHaveBeenCalled()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })

    test("retries with guidance when agent is blank or whitespace", async () => {
        const client = createMockClient()
        const tool = createAutocodeAgentSwapTool(client)

        const emptyAgent = parseToolResult(await tool.execute({ agent: "", prompt: "Use this prompt" }, createToolContext()))
        const blankAgent = parseToolResult(await tool.execute({ agent: "   ", prompt: "Use this prompt" }, createToolContext()))

        expect(emptyAgent.failedAction).toBe("autocode_agent_swap")
        expect(emptyAgent.error).toBe("Invalid agent: ")
        expect(emptyAgent.instruction).toBe("Provide a non-blank agent name.")
        expect(blankAgent.failedAction).toBe("autocode_agent_swap")
        expect(blankAgent.error).toBe("Invalid agent:    ")
        expect(blankAgent.instruction).toBe("Provide a non-blank agent name.")
        expect(client.session.create).not.toHaveBeenCalled()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })

    test("rejects non-string prompts and non-string agents", async () => {
        const client = createMockClient()
        const tool = createAutocodeAgentSwapTool(client)

        const invalidPrompt = parseToolResult(await tool.execute({ agent: "assist", prompt: 123 as never }, createToolContext()))
        const invalidAgent = parseToolResult(await tool.execute({ agent: null as never, prompt: "Use this prompt" }, createToolContext()))

        expect(invalidPrompt.error).toBe("Missing or invalid prompt")
        expect(invalidAgent.error).toBe("Invalid agent: null")
        expect(invalidAgent.instruction).toBe("Provide a non-blank agent name.")
        expect(client.session.create).not.toHaveBeenCalled()
        expect(client.session.update).not.toHaveBeenCalled()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })
})
