import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createAutocodeAgentPreviousTool } from "./autocode_agent_previous"
import { createToolContext } from "./test_context"
import { resetRetryCounts } from "@/utils/tools"

type ParsedToolResult = {
    agent?: string
    error?: string
    failedAction?: string
    instruction?: string
    skipped?: boolean
    reason?: string
    [key: string]: unknown
}

type PreviousPrimaryCase = ["assist" | "auto" | "design" | "research"]

const previousPrimaryCases: PreviousPrimaryCase[] = [
    ["assist"],
    ["auto"],
    ["design"],
    ["research"],
]

function parseToolResult(result: string | { output: string }): ParsedToolResult {
    return JSON.parse(typeof result === "string" ? result : result.output)
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

function createMockClient(messages: ReturnType<typeof createSessionMessage>[]) {
    return {
        session: {
            messages: mock(async () => ({ data: messages })),
            promptAsync: mock(async () => ({})),
        },
    } as unknown as OpencodeClient & {
        session: {
            messages: ReturnType<typeof mock>
            promptAsync: ReturnType<typeof mock>
        }
    }
}

describe("autocode_agent_previous tool", () => {
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

    test("exposes empty args schema", () => {
        const tool = createAutocodeAgentPreviousTool()

        expect(tool.args).toEqual({})
    })

    test.each(previousPrimaryCases)("swaps current session back to previous %s primary agent", async (previousPrimary) => {
        const client = createMockClient([
            createSessionMessage("design", 30),
            createSessionMessage(previousPrimary, 90),
            createSessionMessage("pair", 110),
            createSessionMessage("temp_report", 120),
            createSessionMessage("assist_troubleshoot", 100),
        ])
        const tool = createAutocodeAgentPreviousTool(client)

        const parsed = parseToolResult(await tool.execute({}, createToolContext({
            sessionID: "current-session",
            directory: "/workspace",
            worktree: "/workspace",
            agent: "temp_report",
        })))

        expect(client.session.messages).toHaveBeenCalledWith({
            path: { id: "current-session" },
            query: { directory: "/workspace", limit: 200 },
        })
        expect(client.session.promptAsync).toHaveBeenCalledWith({
            path: { id: "current-session" },
            query: { directory: "/workspace" },
            body: {
                agent: previousPrimary,
                parts: [{ type: "text", text: "Ask user for Next Action." }],
            },
        })
        expect(parsed).toEqual({
            session_id: "current-session",
            agent: previousPrimary,
            session_action: "swapped",
            message: `Swapped current session to ${previousPrimary} (current-session).`,
        })
    })

    test("returns successful skipped response when no previous primary agent exists", async () => {
        const client = createMockClient([
            createSessionMessage("temp_report", 120),
            createSessionMessage("pair", 110),
            createSessionMessage("assist_troubleshoot", 100),
        ])
        const tool = createAutocodeAgentPreviousTool(client)

        const parsed = parseToolResult(await tool.execute({}, createToolContext({
            sessionID: "current-session",
            agent: "temp_report",
        })))

        expect(parsed).toEqual({
            session_id: "current-session",
            skipped: true,
            reason: "No previous primary agent found in current session history.",
            message: "Skipped previous-primary handoff for current session (current-session): No previous primary agent found in current session history.",
        })
        expect(parsed.failedAction).toBeUndefined()
        expect(parsed.instruction).toBeUndefined()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })

    test("returns successful skipped response when session messages API is unavailable", async () => {
        const promptAsync = mock(async () => ({}))
        const client = {
            session: { promptAsync },
        } as unknown as OpencodeClient & { session: { promptAsync: ReturnType<typeof mock> } }
        const tool = createAutocodeAgentPreviousTool(client)

        const parsed = parseToolResult(await tool.execute({}, createToolContext({
            sessionID: "current-session",
            agent: "temp_report",
        })))

        expect(parsed).toEqual({
            session_id: "current-session",
            skipped: true,
            reason: "Unable to inspect current session history: session.messages is unavailable",
            message: "Skipped previous-primary handoff for current session (current-session): Unable to inspect current session history: session.messages is unavailable",
        })
        expect(parsed.failedAction).toBeUndefined()
        expect(parsed.instruction).toBeUndefined()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })

    test("returns successful skipped response when session messages API throws", async () => {
        const client = {
            session: {
                messages: mock(async () => {
                    throw new Error("tcp_error")
                }),
                promptAsync: mock(async () => ({})),
            },
        } as unknown as OpencodeClient & {
            session: {
                messages: ReturnType<typeof mock>
                promptAsync: ReturnType<typeof mock>
            }
        }
        const tool = createAutocodeAgentPreviousTool(client)

        const parsed = parseToolResult(await tool.execute({}, createToolContext({
            sessionID: "current-session",
            directory: "/workspace",
            agent: "temp_report",
        })))

        expect(client.session.messages).toHaveBeenCalledWith({
            path: { id: "current-session" },
            query: { directory: "/workspace", limit: 200 },
        })
        expect(parsed).toEqual({
            session_id: "current-session",
            skipped: true,
            reason: "Autocode session API failed (stage=session_messages, directory=/workspace, session/title=current-session, agent=temp_report): tcp_error",
            message: "Skipped previous-primary handoff for current session (current-session): Autocode session API failed (stage=session_messages, directory=/workspace, session/title=current-session, agent=temp_report): tcp_error",
        })
        expect(parsed.failedAction).toBeUndefined()
        expect(parsed.instruction).toBeUndefined()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })

    test("returns successful skipped response when only current primary agent exists in history", async () => {
        const client = createMockClient([
            createSessionMessage("design", 120),
            createSessionMessage("pair", 110),
            createSessionMessage("assist_troubleshoot", 100),
            createSessionMessage("design", 90),
        ])
        const tool = createAutocodeAgentPreviousTool(client)

        const parsed = parseToolResult(await tool.execute({}, createToolContext({
            sessionID: "current-session",
            agent: "design",
        })))

        expect(parsed).toEqual({
            session_id: "current-session",
            skipped: true,
            reason: "No previous primary agent found in current session history.",
            message: "Skipped previous-primary handoff for current session (current-session): No previous primary agent found in current session history.",
        })
        expect(parsed.failedAction).toBeUndefined()
        expect(parsed.instruction).toBeUndefined()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })
})
