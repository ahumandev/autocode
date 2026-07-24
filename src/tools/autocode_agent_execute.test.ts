import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { resetRetryCounts } from "@/utils/tools"
import { createAutocodeAgentExecuteTool } from "./autocode_agent_execute"
import { createToolContext } from "./test_context"

type ParsedToolResult = {
    current_status?: string
    error?: string
    failedAction?: string
    instruction?: string
    [key: string]: unknown
}

function createMissingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function parseToolResult(result: string | { output: string }): ParsedToolResult {
    return JSON.parse(typeof result === "string" ? result : result.output)
}

function createMockFs() {
    const files: Record<string, string> = {}
    return {
        mkdir: mock(async (_path: string, _opts?: { recursive?: boolean }) => undefined as string | undefined),
        readFile: mock(async (filePath: string, _encoding: "utf8"): Promise<string> => {
            if (filePath in files) return files[filePath]
            throw createMissingError()
        }),
        readdir: mock(async (_path: string, _opts?: { withFileTypes?: boolean }): Promise<string[] | import("fs").Dirent[]> => []),
        rename: mock(async (_oldPath: string, _newPath: string) => { }),
        rm: mock(async (_path: string, _opts?: { recursive?: boolean, force?: boolean }) => { }),
        stat: mock(async (_path: string) => ({ mtimeMs: Date.now() })),
        writeFile: mock(async (filePath: string, content: string) => { files[filePath] = content }),
    }
}

function createMockClient(): OpencodeClient & {
    session: {
        promptAsync: ReturnType<typeof mock>
    }
} {
    return {
        session: {
            promptAsync: mock(async () => ({})),
        },
    } as unknown as OpencodeClient & {
        session: {
            promptAsync: ReturnType<typeof mock>
        }
    }
}

describe("autocode_agent_execute tool", () => {
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

    function writeAutocodeTierConfig(worktree: string, autocodeConfig: Record<string, unknown>): void {
        mkdirSync(join(worktree, ".opencode"), { recursive: true })
        writeFileSync(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({ autocode: autocodeConfig }))
    }

    test("retries when selected job is already in review", async () => {
        const fs = createMockFs()
        const client = createMockClient()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/review" ? ["review_job"] : [])

        const tool = createAutocodeAgentExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ job_name: "review_job", agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            failedAction: "autocode_agent_execute",
            error: "Selected job already in review: review_job",
            instruction: "Select job outside review before retrying autocode_agent_execute.",
        })
        expect(fs.readFile).not.toHaveBeenCalled()
        expect(fs.rename).not.toHaveBeenCalled()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })

    test("returns only current_status after successful handoff", async () => {
        const worktree = mkdtempSync(join(tmpdir(), "autocode-agent-execute-"))
        try {
            const fs = createMockFs()
            const client = createMockClient()
            writeAutocodeTierConfig(worktree, {
                tiers: {
                    balanced: { model: "anthropic/claude-sonnet-4-5", variant: "standard" },
                },
            })
            fs.readdir.mockImplementation(async (dirPath: string) => dirPath === `${worktree}/.agents/jobs/drafts` ? ["assist_job"] : [])
            fs.readFile.mockImplementation(async (filePath: string) => {
                if (filePath === `${worktree}/.agents/jobs/drafts/assist_job/plan.md`) return "# Problem\n\nAssist execution\n"
                throw createMissingError()
            })

            const tool = createAutocodeAgentExecuteTool(client, fs)
            const parsed = parseToolResult(await tool.execute({ job_name: "assist_job", agent: "assist" }, createToolContext({ directory: worktree, worktree })))

            expect(parsed).toEqual({
                current_status: "assist",
            })
            expect(fs.rename).toHaveBeenCalledWith(`${worktree}/.agents/jobs/drafts/assist_job`, `${worktree}/.agents/jobs/assist/assist_job`)
            expect(client.session.promptAsync).toHaveBeenCalledWith({
                path: { id: "session-1" },
                query: { directory: worktree },
                body: {
                    agent: "assist",
                    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
                    parts: [{ type: "text", text: "Selected job: assist_job\n\nplan.md:\n# Problem\n\nAssist execution\n" }],
                },
            })
        } finally {
            rmSync(worktree, { recursive: true, force: true })
        }
    })
})
