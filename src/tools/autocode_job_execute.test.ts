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

function parseToolResult(result: string | { output: string }) {
    return JSON.parse(typeof result === "string" ? result : result.output)
}

type PromptAsyncCall = {
    path: { id: string }
    query: { directory: string }
    body: { agent: string, parts: Array<{ type: string, text?: string }>, model?: unknown }
}

function getPromptAsyncBodies(client: OpencodeClient): PromptAsyncCall["body"][] {
    const promptAsync = (client as OpencodeClient & { session: { promptAsync: ReturnType<typeof mock> } }).session.promptAsync

    return promptAsync.mock.calls.map((call) => (call[0] as PromptAsyncCall).body)
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

function createSessionMessages(userMessageCount: number, assistantMessageCount = 0) {
    const userMessages = Array.from({ length: userMessageCount }, (_, index) => ({
        info: {
            id: `user-${index + 1}`,
            role: "user",
            sessionID: "session-1",
            time: {
                created: index + 1,
            },
        },
        parts: [{
            type: "text",
            text: `message ${index + 1}`,
            messageID: `user-${index + 1}`,
            time: {
                start: index + 1,
                end: index + 1,
            },
        }],
    }))
    const assistantMessages = Array.from({ length: assistantMessageCount }, (_, index) => ({
        info: {
            id: `assistant-${index + 1}`,
            role: "assistant",
            sessionID: "session-1",
            time: {
                created: userMessageCount + index + 1,
            },
        },
        parts: [{
            type: "text",
            text: `assistant message ${index + 1}`,
            messageID: `assistant-${index + 1}`,
            time: {
                start: userMessageCount + index + 1,
                end: userMessageCount + index + 1,
            },
        }],
    }))

    return [...userMessages, ...assistantMessages] as Awaited<ReturnType<NonNullable<OpencodeClient["session"]["messages"]>>>["data"]
}

function createMockClient(title: string | undefined, prompts: string[] = [], agents: string[] = [], userMessageCount = 1, assistantMessageCount = 0): OpencodeClient {
    return {
        session: {
            get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                data: { id: args.path.id, directory: args.query.directory, title },
            })),
            messages: mock(async () => ({
                data: createSessionMessages(userMessageCount, assistantMessageCount),
            })),
            update: mock(async (): Promise<{ data?: { id: string }, error?: string }> => ({
                data: { id: "session-1" },
            })),
            create: mock(async (args: { query?: { directory?: string }, body?: { title?: string } }): Promise<{ data?: { id: string, directory?: string, title?: string }, error?: string }> => ({
                data: {
                    id: "new-session",
                    directory: args.query?.directory,
                    title: args.body?.title,
                },
            })),
            promptAsync: mock(async (args: PromptAsyncCall) => {
                const firstPart = args.body.parts[0]
                agents.push(args.body.agent)
                prompts.push(firstPart?.type === "text" && firstPart.text !== undefined ? firstPart.text : "")
                return {}
            }),
        },
    } as unknown as OpencodeClient
}

function writeAutocodeTierConfig(worktree: string, autocodeConfig: Record<string, unknown>): void {
    mkdirSync(join(worktree, ".opencode"), { recursive: true })
    writeFileSync(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({ autocode: autocodeConfig }))
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
        if (previousXdgConfigHome === undefined) {
            delete process.env.XDG_CONFIG_HOME
        } else {
            process.env.XDG_CONFIG_HOME = previousXdgConfigHome
        }

        if (xdgConfigHome) {
            rmSync(xdgConfigHome, { recursive: true, force: true })
        }
    })

    test("creates a fresh assist session for a short conversation when the resolved plan exists", async () => {
        const fs = createMockFs()
        const prompts: string[] = []
        const agents: string[] = []
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["test_job"] : [])
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/drafts/test_job/plan.md") return "# Problem\n\nShip title-based execution\n"
            throw createMissingError()
        })

        const client = createMockClient("Test Job (drafts)", prompts, agents, 2) as OpencodeClient & {
            session: {
                create: ReturnType<typeof mock>
                update: ReturnType<typeof mock>
            }
        }
        const tool = createAutocodeJobExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "session_created",
            job_name: "test_job",
            current_status: "assist",
            file_path: ".agents/jobs/assist/test_job/plan.md",
            job_path: ".agents/jobs/assist/test_job/",
            session_id: "new-session",
            session_title: "Test Job (assist)",
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/test_job", "/workspace/.agents/jobs/assist/test_job")
        expect(getPromptAsyncBodies(client).map((body) => body.agent)).toEqual(["assist"])
        expect(getPromptAsyncBodies(client).map((body) => body.parts[0]?.text)).toEqual(["# Problem\n\nShip title-based execution\n"])
        expect(client.session.create).toHaveBeenCalledTimes(1)
        expect(client.session.update).not.toHaveBeenCalled()
    })

    test("creates a session for a title-resolved job with three user and six assistant messages when the plan exists", async () => {
        const fs = createMockFs()
        const prompts: string[] = []
        const agents: string[] = []
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["test_job"] : [])
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/drafts/test_job/plan.md") return "# Problem\n\nShip resolved execution\n"
            throw createMissingError()
        })

        const client = createMockClient("Test Job", prompts, agents, 3, 6) as OpencodeClient & {
            session: {
                create: ReturnType<typeof mock>
                update: ReturnType<typeof mock>
            }
        }
        const tool = createAutocodeJobExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "session_created",
            job_name: "test_job",
            current_status: "assist",
            file_path: ".agents/jobs/assist/test_job/plan.md",
            job_path: ".agents/jobs/assist/test_job/",
            session_id: "new-session",
            session_title: "Test Job (assist)",
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/test_job", "/workspace/.agents/jobs/assist/test_job")
        expect(getPromptAsyncBodies(client).map((body) => body.agent)).toEqual(["assist"])
        expect(getPromptAsyncBodies(client).map((body) => body.parts[0]?.text)).toEqual(["# Problem\n\nShip resolved execution\n"])
        expect(client.session.create).toHaveBeenCalledTimes(1)
        expect(client.session.update).not.toHaveBeenCalled()
    })

    test("returns retry instead of propose when a title-resolved job is missing plan.md", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["test_job"] : [])

        const client = createMockClient("Test Job", [], [], 3, 6) as OpencodeClient & {
            session: {
                create: ReturnType<typeof mock>
            }
        }
        const tool = createAutocodeJobExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            failedAction: "autocode_job_execute",
            error: "Resolved planned job is missing a required file: test_job",
            instruction: "Restore the planned job plan.md file under .agents/jobs/ before retrying execution.",
        })
        expect(parsed.result_type).not.toBe("propose")
        expect(client.session.create).not.toHaveBeenCalled()
    })

    test("does not move the planned job when fresh session prompt dispatch fails", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["test_job"] : [])
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/drafts/test_job/plan.md") return "# Problem\n\nDo not move before prompt succeeds\n"
            throw createMissingError()
        })

        const client = createMockClient("Test Job", [], [], 3) as OpencodeClient & {
            session: {
                create: ReturnType<typeof mock>
                promptAsync: ReturnType<typeof mock>
            }
        }
        client.session.promptAsync.mockImplementationOnce(async () => ({ error: "prompt failed" }))
        const tool = createAutocodeJobExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ agent: "auto" }, createToolContext()))

        expect(parsed.failedAction).toBe("autocode_job_execute")
        expect(parsed.error).toBe("Autocode session API failed (stage=prompt_dispatch, directory=/workspace, session/title=new-session, agent=auto): prompt failed")
        expect(client.session.create).toHaveBeenCalledTimes(1)
        expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
        expect(fs.rename).not.toHaveBeenCalled()
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("creates a session for an explicitly selected job when the current conversation is longer", async () => {
        const fs = createMockFs()
        const prompts: string[] = []
        const agents: string[] = []
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/review" ? ["review_job"] : [])
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/review/review_job/plan.md") return "# Problem\n\nReview execution\n"
            throw createMissingError()
        })

        const client = createMockClient("Review Job", prompts, agents, 3) as OpencodeClient & {
            session: {
                create: ReturnType<typeof mock>
                update: ReturnType<typeof mock>
            }
        }
        const tool = createAutocodeJobExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "session_created",
            job_name: "review_job",
            current_status: "review",
            file_path: ".agents/jobs/review/review_job/plan.md",
            job_path: ".agents/jobs/review/review_job/",
            session_id: "new-session",
            session_title: "Review Job (review)",
        })
        expect(fs.rename).not.toHaveBeenCalled()
        expect(getPromptAsyncBodies(client).map((body) => body.agent)).toEqual(["assist"])
        expect(getPromptAsyncBodies(client).map((body) => body.parts[0]?.text)).toEqual(["# Problem\n\nReview execution\n"])
        expect(client.session.create).toHaveBeenCalledTimes(1)
        expect(client.session.update).not.toHaveBeenCalled()
    })

    test("creates an auto session with lifecycle job rules and moves the job into executing", async () => {
        const fs = createMockFs()
        const prompts: string[] = []
        const agents: string[] = []
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["auto_job"] : [])
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/drafts/auto_job/plan.md") return "# Problem\n\nAuto execution\n"
            throw createMissingError()
        })

        const client = createMockClient("Auto Job", prompts, agents, 3) as OpencodeClient & {
            session: {
                create: ReturnType<typeof mock>
                update: ReturnType<typeof mock>
            }
        }
        const tool = createAutocodeJobExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ agent: "auto" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "session_created",
            job_name: "auto_job",
            current_status: "executing",
            file_path: ".agents/jobs/executing/auto_job/plan.md",
            job_path: ".agents/jobs/executing/auto_job/",
            session_id: "new-session",
            session_title: "Auto Job (executing)",
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/auto_job", "/workspace/.agents/jobs/executing/auto_job")
        expect(getPromptAsyncBodies(client).map((body) => body.agent)).toEqual(["auto"])
        expect(getPromptAsyncBodies(client).map((body) => body.parts[0]?.text)).toEqual(["# Problem\n\nAuto execution\n"])
        expect(client.session.create).toHaveBeenCalledWith({
            query: { directory: "/workspace" },
            body: { title: "Auto Job (executing)" },
        })
        expect(client.session.create).toHaveBeenCalledTimes(1)
        expect(client.session.update).not.toHaveBeenCalled()
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/executing/auto_job/session.yml", "session_id: new-session\n")
    })

    test("uses a persisted existing session for an executing job", async () => {
        const fs = createMockFs()
        const prompts: string[] = []
        const agents: string[] = []
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/executing" ? ["auto_job"] : [])
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/executing/auto_job/plan.md") return "# Problem\n\nResume auto execution\n"
            if (filePath === "/workspace/.agents/jobs/executing/auto_job/session.yml") return "session_id: existing-session\n"
            throw createMissingError()
        })

        const client = createMockClient("Auto Job", prompts, agents, 3) as OpencodeClient & {
            session: {
                create: ReturnType<typeof mock>
                get: ReturnType<typeof mock>
                promptAsync: ReturnType<typeof mock>
            }
        }
        const tool = createAutocodeJobExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ agent: "auto" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "session_created",
            job_name: "auto_job",
            current_status: "executing",
            file_path: ".agents/jobs/executing/auto_job/plan.md",
            job_path: ".agents/jobs/executing/auto_job/",
            session_id: "existing-session",
            session_title: "Auto Job (executing)",
        })
        expect(client.session.get).toHaveBeenCalledWith({ path: { id: "existing-session" }, query: { directory: "/workspace" } })
        expect(client.session.create).not.toHaveBeenCalled()
        expect(client.session.update).not.toHaveBeenCalled()
        expect(getPromptAsyncBodies(client)).toContainEqual({
            agent: "auto",
            parts: [{ type: "text", text: "# Problem\n\nResume auto execution\n" }],
        })
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("creates a new session when the persisted session is not retrievable", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/executing" ? ["auto_job"] : [])
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/executing/auto_job/plan.md") return "# Problem\n\nRestart auto execution\n"
            if (filePath === "/workspace/.agents/jobs/executing/auto_job/session.yml") return "session_id: deleted-session\n"
            throw createMissingError()
        })

        const client = createMockClient("Auto Job") as OpencodeClient & {
            session: {
                create: ReturnType<typeof mock>
                get: ReturnType<typeof mock>
            }
        }
        client.session.get.mockImplementation(async (args: { path: { id: string }, query: { directory: string } }) => {
            if (args.path.id === "deleted-session") return { error: "not found" }

            return {
                data: { id: args.path.id, directory: args.query.directory, title: "Auto Job" },
            }
        })
        const tool = createAutocodeJobExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ agent: "auto" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "session_created",
            job_name: "auto_job",
            current_status: "executing",
            file_path: ".agents/jobs/executing/auto_job/plan.md",
            job_path: ".agents/jobs/executing/auto_job/",
            session_id: "new-session",
            session_title: "Auto Job (executing)",
        })
        expect(client.session.create).toHaveBeenCalledTimes(1)
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/executing/auto_job/session.yml", "session_id: new-session\n")
    })

    test("creates and dispatches a long-context auto session with configured smart model", async () => {
        const worktree = mkdtempSync(join(tmpdir(), "autocode-job-execute-"))
        const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
        const xdgConfigHome = mkdtempSync(join(tmpdir(), "autocode-config-home-"))
        try {
            process.env.XDG_CONFIG_HOME = xdgConfigHome
            writeAutocodeTierConfig(worktree, {
                tiers: {
                    balanced: { model: "anthropic/claude-sonnet-4-5", variant: "standard" },
                    smart: { model: "openai/gpt-5.5", variant: "thinking" },
                },
            })

            const fs = createMockFs()
            fs.readdir.mockImplementation(async (dirPath: string) => dirPath === `${worktree}/.agents/jobs/drafts` ? ["auto_job"] : [])
            fs.readFile.mockImplementation(async (filePath: string) => {
                if (filePath === `${worktree}/.agents/jobs/drafts/auto_job/plan.md`) return "# Problem\n\nLong auto execution\n"
                throw createMissingError()
            })

            const client = createMockClient("Auto Job", [], [], 8, 10) as OpencodeClient & {
                session: {
                    create: ReturnType<typeof mock>
                    promptAsync: ReturnType<typeof mock>
                }
            }
            const tool = createAutocodeJobExecuteTool(client, fs)

            await tool.execute({ agent: "auto" }, createToolContext({ directory: worktree, worktree }))

            expect(client.session.create).toHaveBeenCalledTimes(1)
            expect(getPromptAsyncBodies(client)).toContainEqual({
                agent: "auto",
                model: { providerID: "openai", modelID: "gpt-5.5" },
                parts: [{ type: "text", text: "# Problem\n\nLong auto execution\n" }],
            })
        } finally {
            if (previousXdgConfigHome === undefined) {
                delete process.env.XDG_CONFIG_HOME
            } else {
                process.env.XDG_CONFIG_HOME = previousXdgConfigHome
            }
            rmSync(xdgConfigHome, { recursive: true, force: true })
            rmSync(worktree, { recursive: true, force: true })
        }
    })

    test("dispatches an assist execution session with configured balanced model", async () => {
        const worktree = mkdtempSync(join(tmpdir(), "autocode-job-execute-"))
        const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
        const xdgConfigHome = mkdtempSync(join(tmpdir(), "autocode-config-home-"))
        try {
            process.env.XDG_CONFIG_HOME = xdgConfigHome
            writeAutocodeTierConfig(worktree, {
                tiers: {
                    balanced: { model: "anthropic/claude-sonnet-4-5", variant: "standard" },
                    smart: { model: "openai/gpt-5.5", variant: "thinking" },
                },
            })

            const fs = createMockFs()
            fs.readdir.mockImplementation(async (dirPath: string) => dirPath === `${worktree}/.agents/jobs/drafts` ? ["assist_job"] : [])
            fs.readFile.mockImplementation(async (filePath: string) => {
                if (filePath === `${worktree}/.agents/jobs/drafts/assist_job/plan.md`) return "# Problem\n\nAssist execution\n"
                throw createMissingError()
            })

            const client = createMockClient("Assist Job", [], [], 4, 7) as OpencodeClient & {
                session: {
                    promptAsync: ReturnType<typeof mock>
                }
            }
            const tool = createAutocodeJobExecuteTool(client, fs)

            await tool.execute({ agent: "assist" }, createToolContext({ directory: worktree, worktree }))

            expect(getPromptAsyncBodies(client)).toContainEqual({
                agent: "assist",
                model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
                parts: [{ type: "text", text: "# Problem\n\nAssist execution\n" }],
            })
        } finally {
            if (previousXdgConfigHome === undefined) {
                delete process.env.XDG_CONFIG_HOME
            } else {
                process.env.XDG_CONFIG_HOME = previousXdgConfigHome
            }
            rmSync(xdgConfigHome, { recursive: true, force: true })
            rmSync(worktree, { recursive: true, force: true })
        }
    })

    test("uses the first resolved duplicate entry for direct execution", async () => {
        const fs = createMockFs()
        const prompts: string[] = []
        const agents: string[] = []
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/drafts") return ["shared_job"]
            if (dirPath === "/workspace/.agents/jobs/review") return ["shared_job"]
            return []
        })
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/drafts/shared_job/plan.md") return "# Problem\n\nDraft duplicate wins\n"
            throw createMissingError()
        })

        const client = createMockClient("Shared Job", prompts, agents, 3) as OpencodeClient & {
            session: {
                create: ReturnType<typeof mock>
                update: ReturnType<typeof mock>
            }
        }
        const tool = createAutocodeJobExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "session_created",
            job_name: "shared_job",
            current_status: "assist",
            file_path: ".agents/jobs/assist/shared_job/plan.md",
            job_path: ".agents/jobs/assist/shared_job/",
            session_id: "new-session",
            session_title: "Shared Job (assist)",
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/shared_job", "/workspace/.agents/jobs/assist/shared_job")
        expect(getPromptAsyncBodies(client).map((body) => body.agent)).toEqual(["assist"])
        expect(getPromptAsyncBodies(client).map((body) => body.parts[0]?.text)).toEqual(["# Problem\n\nDraft duplicate wins\n"])
        expect(client.session.create).toHaveBeenCalledTimes(1)
        expect(client.session.update).not.toHaveBeenCalled()
    })

    test("returns draft_required for an unresolved title-derived job", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/drafts") return ["draft_job"]
            if (dirPath === "/workspace/.agents/jobs/facilitate") return ["facilitate_job"]
            if (dirPath === "/workspace/.agents/jobs/review") return ["review_job"]
            if (dirPath === "/workspace/.agents/jobs/executing") return ["executing_job"]
            if (dirPath === "/workspace/.agents/jobs/facilitate/facilitate_job") return []
            if (dirPath === "/workspace/.agents/jobs/drafts/draft_job") return []
            return []
        })
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith("draft_job/plan.md")) return "# Problem\n\nDraft work\n"
            if (filePath.endsWith("facilitate_job/plan.md")) return "# Problem\n\nFacilitate work\n"
            if (filePath.endsWith("review_job/plan.md")) return "# Problem\n\nReview work\n"
            if (filePath.endsWith("executing_job/plan.md")) return "# Problem\n\nExecuting work\n"
            throw createMissingError()
        })

        const tool = createAutocodeJobExecuteTool(createMockClient("Missing Job"), fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "draft_required",
            job_name: "missing_job",
            warning: "Current session title did not match a planned job: Missing Job",
        })
    })

    test("returns draft_required when a title-derived job is unresolved and selectable plans exist", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/drafts") return ["draft_job"]
            if (dirPath === "/workspace/.agents/jobs/facilitate") return ["facilitate_job"]
            if (dirPath === "/workspace/.agents/jobs/review") return ["review_job"]
            if (dirPath === "/workspace/.agents/jobs/executing") return ["executing_job"]
            if (dirPath === "/workspace/.agents/jobs/facilitate/facilitate_job") return []
            if (dirPath === "/workspace/.agents/jobs/drafts/draft_job") return []
            return []
        })
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith("draft_job/plan.md")) return "# Problem\n\nDraft work\n"
            if (filePath.endsWith("facilitate_job/plan.md")) return "# Problem\n\nFacilitate work\n"
            if (filePath.endsWith("review_job/plan.md")) return "# Problem\n\nReview work\n"
            if (filePath.endsWith("executing_job/plan.md")) return "# Problem\n\nExecuting work\n"
            throw createMissingError()
        })

        const tool = createAutocodeJobExecuteTool(createMockClient(undefined), fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "draft_required",
            job_name: "message_1",
            warning: "Current session title did not match a planned job: message 1",
        })
    })

    test("returns draft_required for a session with multiple user messages when job is unresolved", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/drafts") return ["draft_job"]
            return []
        })
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith("draft_job/plan.md")) return "# Problem\n\nDraft work\n"
            throw createMissingError()
        })

        const tool = createAutocodeJobExecuteTool(createMockClient("Missing Job", [], [], 3, 6), fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "draft_required",
            job_name: "missing_job",
            warning: "Current session title did not match a planned job: Missing Job",
        })
    })

    test("returns retry before propose when a planned job is already resolved but plan.md is missing", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["draft_job"] : [])

        const client = createMockClient("Draft Job", [], [], 2) as OpencodeClient & {
            session: {
                update: ReturnType<typeof mock>
            }
        }
        const tool = createAutocodeJobExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            failedAction: "autocode_job_execute",
            error: "Resolved planned job is missing a required file: draft_job",
            instruction: "Restore the planned job plan.md file under .agents/jobs/ before retrying execution.",
        })
        expect(parsed.result_type).not.toBe("propose")
        expect(client.session.update).not.toHaveBeenCalled()
    })

    test("creates a fresh session without updating the current title when the resolved plan exists", async () => {
        const fs = createMockFs()
        const prompts: string[] = []
        const agents: string[] = []
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["test_job"] : [])
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/drafts/test_job/plan.md") return "# Problem\n\nShip title-based execution\n"
            throw createMissingError()
        })

        const client = createMockClient("Test Job", prompts, agents, 2) as OpencodeClient & {
            session: {
                update: ReturnType<typeof mock>
            }
        }
        client.session.update.mockImplementationOnce(async () => ({ data: { id: "session-1" } }))
        client.session.update.mockImplementationOnce(async () => ({ error: "rename failed" }))

        const tool = createAutocodeJobExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "session_created",
            job_name: "test_job",
            current_status: "assist",
            file_path: ".agents/jobs/assist/test_job/plan.md",
            job_path: ".agents/jobs/assist/test_job/",
            session_id: "new-session",
            session_title: "Test Job (assist)",
        })
        expect(client.session.update).not.toHaveBeenCalled()
    })

    test("returns retry instead of title-update warning when a resolved job has no plan.md", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["draft_job"] : [])

        const client = {
            session: {
                get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                    data: { id: args.path.id, directory: args.query.directory, title: "Draft Job" },
                })),
                messages: mock(async () => ({
                    data: createSessionMessages(2),
                })),
            },
        } as unknown as OpencodeClient
        const tool = createAutocodeJobExecuteTool(client, fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            failedAction: "autocode_job_execute",
            error: "Resolved planned job is missing a required file: draft_job",
            instruction: "Restore the planned job plan.md file under .agents/jobs/ before retrying execution.",
        })
        expect(parsed.result_type).not.toBe("propose")
    })

    test("returns draft_required instead of listing jobs for an unresolved title-derived job", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/drafts") return ["shared_job", "draft_job"]
            if (dirPath === "/workspace/.agents/jobs/review") return ["shared_job"]
            return []
        })
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith("draft_job/plan.md")) return "# Problem\n\nDraft work\n"
            if (filePath.endsWith("drafts/shared_job/plan.md")) return "# Problem\n\nDraft duplicate wins\n"
            if (filePath.endsWith("review/shared_job/plan.md")) return "# Problem\n\nReview duplicate loses\n"
            throw createMissingError()
        })

        const tool = createAutocodeJobExecuteTool(createMockClient("Missing Job"), fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "draft_required",
            job_name: "missing_job",
            warning: "Current session title did not match a planned job: Missing Job",
        })
    })

    test("returns draft_required when a title-derived job is unresolved with selectable plans", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/concepts") return ["concept_job"]
            if (dirPath === "/workspace/.agents/jobs/executing") return ["executing_job"]
            if (dirPath === "/workspace/.agents/jobs/concepts/concept_job") return []
            return []
        })
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith("concept_job/plan.md")) return "# Problem\n\nConcept work\n"
            if (filePath.endsWith("executing_job/plan.md")) return "# Problem\n\nExecuting work\n"
            throw createMissingError()
        })

        const tool = createAutocodeJobExecuteTool(createMockClient("Missing Job"), fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "draft_required",
            job_name: "missing_job",
            warning: "Current session title did not match a planned job: Missing Job",
        })
    })

    test("returns no_plans when a title-derived job is unresolved and no plans exist", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/concepts" ? ["concept_job"] : [])
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith("concept_job/plan.md")) return "# Problem\n\nConcept work\n"
            throw createMissingError()
        })

        const tool = createAutocodeJobExecuteTool(createMockClient("Missing Job"), fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "no_plans",
        })
    })

    test("returns draft_required instead of listing selectable jobs", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/drafts") return ["draft_job"]
            if (dirPath === "/workspace/.agents/jobs/assist") return ["assist_job"]
            if (dirPath === "/workspace/.agents/jobs/executing") return ["executing_job"]
            if (dirPath === "/workspace/.agents/jobs/facilitate") return ["facilitate_job"]
            if (dirPath === "/workspace/.agents/jobs/review") return ["review_job"]
            return []
        })
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith("draft_job/plan.md")) return "# Problem\n\nDraft work\n"
            if (filePath.endsWith("assist_job/plan.md")) return "# Problem\n\nAssist work\n"
            if (filePath.endsWith("executing_job/plan.md")) return "# Problem\n\nExecuting work\n"
            if (filePath.endsWith("facilitate_job/plan.md")) return "# Problem\n\nFacilitate work\n"
            if (filePath.endsWith("review_job/plan.md")) return "# Problem\n\nReview work\n"
            throw createMissingError()
        })

        const tool = createAutocodeJobExecuteTool(createMockClient("Missing Job"), fs)
        const parsed = parseToolResult(await tool.execute({ agent: "assist" }, createToolContext()))

        expect(parsed).toEqual({
            result_type: "draft_required",
            job_name: "missing_job",
            warning: "Current session title did not match a planned job: Missing Job",
        })
    })

    test("rejects invalid agent", async () => {
        const result = await createAutocodeJobExecuteTool(createMockClient("Anything"), createMockFs()).execute({ agent: "design" }, createToolContext())

        expect(result).toBe(createRetryResponse(
            "autocode_job_execute",
            "Invalid agent: design",
            "Provide agent as one of: auto, assist."
        ))
    })

})
