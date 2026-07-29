import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createRetryResponse } from "@/utils/tools"
import { createAutocodeJobExecuteTool } from "./autocode_job_execute"
import { createNoopAsk } from "./test_context"

function createMissingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        sessionID: "session-1",
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

function parseToolResult(result: string | { output: string }): Record<string, unknown> {
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function createMockFs() {
    return {
        readFile: mock(async (_path: string, _encoding: "utf-8" | "utf8"): Promise<string> => { throw createMissingError() }),
        readdir: mock(async (_path: string, _opts?: { withFileTypes?: boolean }) => [] as string[] | import("fs").Dirent[]),
        mkdir: mock(async (_path: string, _opts?: { recursive?: boolean }) => undefined as string | undefined),
        rm: mock(async (_path: string, _opts?: { recursive?: boolean, force?: boolean }) => { }),
        stat: mock(async (_path: string) => ({ mtimeMs: Date.now() })),
        rename: mock(async (_oldPath: string, _newPath: string) => { }),
        writeFile: mock(async (_path: string, _content: string) => { }),
    }
}

type PromptCall = {
    path: { id: string }
    query: { directory: string }
    body: { agent: string, parts: Array<{ type: string, text?: string }>, model?: unknown }
}

type MockClient = OpencodeClient & {
    session: {
        create: ReturnType<typeof mock>
        messages: ReturnType<typeof mock>
        promptAsync: ReturnType<typeof mock>
        summarize: ReturnType<typeof mock>
        update: ReturnType<typeof mock>
    }
}

function createMockClient(events: string[], messageIDs = ["user-1", "assistant-1"]): MockClient {
    return {
        session: {
            get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                data: { id: args.path.id, directory: args.query.directory, title: "Test Job" },
            })),
            messages: mock(async () => ({
                data: messageIDs.map((id, index) => ({
                    info: { id, role: index === 0 ? "user" : "assistant", sessionID: "session-1", time: { created: index } },
                    parts: [],
                })),
            })),
            summarize: mock(async () => {
                events.push("summarize")
                return { data: undefined, error: undefined }
            }),
            update: mock(async (args: { body: { title: string } }) => {
                events.push(`title:${args.body.title}`)
                return { data: { id: "session-1" } }
            }),
            create: mock(async () => ({ data: { id: "new-session" } })),
            promptAsync: mock(async (args: PromptCall) => {
                events.push("dispatch")
                return {}
            }),
        },
    } as unknown as MockClient
}

function configureResolvedDraft(fs: ReturnType<typeof createMockFs>, plan = "# Problem\n\nShip execution\n"): void {
    fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["test_job"] : [])
    fs.readFile.mockImplementation(async (filePath: string) => {
        if (filePath === "/workspace/.agents/jobs/drafts/test_job/plan.md") return plan
        throw createMissingError()
    })
}

describe("autocode_job_execute tool", () => {
    let xdgConfigHome: string | undefined
    let previousXdgConfigHome: string | undefined

    beforeEach(() => {
        previousXdgConfigHome = process.env.XDG_CONFIG_HOME
        xdgConfigHome = mkdtempSync(join(tmpdir(), "autocode-config-home-"))
        process.env.XDG_CONFIG_HOME = xdgConfigHome
    })

    afterEach(() => {
        if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
        if (xdgConfigHome) rmSync(xdgConfigHome, { recursive: true, force: true })
    })

    test("compacts current session, retitles it, dispatches selected plan, and persists same session", async () => {
        const fs = createMockFs()
        const events: string[] = []
        configureResolvedDraft(fs)
        const client = createMockClient(events, ["user-1", "assistant-1", "assistant-2"])

        const parsed = parseToolResult(await createAutocodeJobExecuteTool(client, fs).execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "session_created",
            job_name: "test_job",
            session_id: "session-1",
            session_title: "Test Job (facilitate)",
        })
        expect(client.session.summarize).toHaveBeenCalledTimes(1)
        expect(events).toEqual([
            "title:Test Job (facilitate)",
            "summarize",
            "dispatch",
        ])
        expect(client.session.update).toHaveBeenCalledWith({
            path: { id: "session-1" },
            query: { directory: "/workspace" },
            body: { title: "Test Job (facilitate)" },
        })
        expect(client.session.create).not.toHaveBeenCalled()
        expect(client.session.promptAsync).toHaveBeenCalledWith({
            path: { id: "session-1" },
            query: { directory: "/workspace" },
            body: {
                agent: "assist",
                parts: [{ type: "text", text: "Selected job: test_job\n\nUse this plan as job instructions. Start first actionable unblocked step. Ask user when decision needed. Do safe work. Do not assume later plan context.\n\nplan.md:\n# Problem\n\nShip execution\n" }],
            },
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/test_job", "/workspace/.agents/jobs/facilitate/test_job")
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/facilitate/test_job/session.yml", "session_id: session-1\n")
    })

    test("compacts current session and dispatches plan with teach", async () => {
        const fs = createMockFs()
        const events: string[] = []
        configureResolvedDraft(fs, "# Lesson\n\nExplain this change\n")
        const client = createMockClient(events)

        await createAutocodeJobExecuteTool(client, fs).execute({ agent: "teach" }, createToolContext())

        expect(events).toEqual([
            "title:Test Job (facilitate)",
            "summarize",
            "dispatch",
        ])
        expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
            path: { id: "session-1" },
            body: expect.objectContaining({
                agent: "teach",
                parts: [{ type: "text", text: "Selected job: test_job\n\nUse this plan as job instructions. Start first actionable unblocked step. Ask user when decision needed. Do safe work. Do not assume later plan context.\n\nplan.md:\n# Lesson\n\nExplain this change\n" }],
            }),
        }))
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/test_job", "/workspace/.agents/jobs/facilitate/test_job")
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/facilitate/test_job/session.yml", "session_id: session-1\n")
    })

    test("dispatches assist with balanced model and omits standard variant in current session", async () => {
        const worktree = mkdtempSync(join(tmpdir(), "autocode-job-execute-"))
        try {
            mkdirSync(join(worktree, ".opencode"), { recursive: true })
            writeFileSync(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({
                autocode: { tiers: { balanced: { model: "anthropic/claude-sonnet-4-5", variant: "standard" } } },
            }))
            const fs = createMockFs()
            fs.readdir.mockImplementation(async (dirPath: string) => dirPath === `${worktree}/.agents/jobs/drafts` ? ["test_job"] : [])
            fs.readFile.mockImplementation(async (filePath: string) => {
                if (filePath === `${worktree}/.agents/jobs/drafts/test_job/plan.md`) return "plan"
                throw createMissingError()
            })
            const client = createMockClient([])

            await createAutocodeJobExecuteTool(client, fs).execute({ agent: "assist" }, createToolContext({ directory: worktree, worktree }))

            expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
                path: { id: "session-1" },
                body: expect.objectContaining({
                    agent: "assist",
                    model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
                }),
            }))
            expect(client.session.create).not.toHaveBeenCalled()
            expect(fs.rename).toHaveBeenCalledWith(`${worktree}/.agents/jobs/drafts/test_job`, `${worktree}/.agents/jobs/facilitate/test_job`)
            expect(fs.writeFile).toHaveBeenCalledWith(`${worktree}/.agents/jobs/facilitate/test_job/session.yml`, "session_id: session-1\n")
        } finally {
            rmSync(worktree, { recursive: true, force: true })
        }
    })

    test("dispatches auto with smart model and configured reasoning variant in current session", async () => {
        const worktree = mkdtempSync(join(tmpdir(), "autocode-job-execute-"))
        try {
            mkdirSync(join(worktree, ".opencode"), { recursive: true })
            writeFileSync(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({
                autocode: { tiers: { smart: { model: "openai/gpt-5.5", variant: "thinking" } } },
            }))
            const fs = createMockFs()
            fs.readdir.mockImplementation(async (dirPath: string) => dirPath === `${worktree}/.agents/jobs/drafts` ? ["test_job"] : [])
            fs.readFile.mockImplementation(async (filePath: string) => {
                if (filePath === `${worktree}/.agents/jobs/drafts/test_job/plan.md`) return "plan"
                throw createMissingError()
            })
            const client = createMockClient([])

            await createAutocodeJobExecuteTool(client, fs).execute({ agent: "auto" }, createToolContext({ directory: worktree, worktree }))

            expect(client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
                path: { id: "session-1" },
                body: expect.objectContaining({
                    agent: "auto",
                    model: { providerID: "openai", modelID: "gpt-5.5", variant: "thinking" },
                }),
            }))
            expect(client.session.create).not.toHaveBeenCalled()
            expect(fs.rename).toHaveBeenCalledWith(`${worktree}/.agents/jobs/drafts/test_job`, `${worktree}/.agents/jobs/executing/test_job`)
            expect(fs.writeFile).toHaveBeenCalledWith(`${worktree}/.agents/jobs/executing/test_job/session.yml`, "session_id: session-1\n")
        } finally {
            rmSync(worktree, { recursive: true, force: true })
        }
    })

    test("does not move job when current-session dispatch fails", async () => {
        const fs = createMockFs()
        configureResolvedDraft(fs)
        const client = createMockClient([])
        client.session.promptAsync.mockImplementationOnce(async () => ({ error: "prompt failed" }))

        const parsed = parseToolResult(await createAutocodeJobExecuteTool(client, fs).execute({ agent: "auto" }, createToolContext()))

        expect(parsed.error).toBe("Autocode session API failed (stage=prompt_dispatch, directory=/workspace, session/title=session-1, agent=auto): prompt failed")
        expect(client.session.create).not.toHaveBeenCalled()
        expect(fs.rename).not.toHaveBeenCalled()
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("returns retry without session changes when resolved plan is missing", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["test_job"] : [])
        const client = createMockClient([])

        const result = await createAutocodeJobExecuteTool(client, fs).execute({ agent: "assist" }, createToolContext())

        expect(result).toBe(createRetryResponse(
            "autocode_job_execute",
            "Resolved planned job is missing a required file: test_job",
            "Restore the planned job plan.md file under .agents/jobs/ before retrying execution."
        ))
        expect(client.session.summarize).not.toHaveBeenCalled()
        expect(client.session.update).not.toHaveBeenCalled()
        expect(client.session.create).not.toHaveBeenCalled()
    })

    test("rejects invalid agent without job lookup or session changes", async () => {
        const fs = createMockFs()
        const client = createMockClient([])

        const result = await createAutocodeJobExecuteTool(client, fs).execute({ agent: "invalid" }, createToolContext())

        expect(result).toBe(createRetryResponse(
            "autocode_job_execute",
            "Invalid agent: invalid",
            "Provide agent as one of: auto, assist, teach."
        ))
        expect(fs.readdir).not.toHaveBeenCalled()
        expect(client.session.summarize).not.toHaveBeenCalled()
        expect(client.session.create).not.toHaveBeenCalled()
        expect(client.session.promptAsync).not.toHaveBeenCalled()
    })
})
