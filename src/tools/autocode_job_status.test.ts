import { describe, beforeEach, expect, mock, test } from "bun:test"
import type { Dirent } from "fs"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createAbortResponse, createLifecycleJobRequiredRetryResponse, createRetryResponse, resetRetryCounts } from "@/utils/tools"
import { createToolContext } from "./test_context"
import { createAutocodeJobStatusTool } from "./autocode_job_status"

function createMissingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

describe("autocode_job_status tool", () => {
    beforeEach(() => { resetRetryCounts() })

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

    function createDirent(name: string): Dirent {
        return { name, isDirectory: () => true, isFile: () => false } as Dirent
    }

    function createClient(title: string | null | undefined, assistantText = "Execution started.", options?: { includeMessages?: boolean, messagesError?: string }): OpencodeClient {
        return {
            session: {
                get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                    data: { id: args.path.id, title, directory: args.query.directory },
                })),
                update: mock(async (args: { path: { id: string }, query: { directory: string }, body: { title: string } }) => ({
                    data: { id: args.path.id, title: args.body.title, directory: args.query.directory },
                })),
                ...(options?.includeMessages === false ? {} : {
                    messages: mock(async () => options?.messagesError
                        ? ({ error: options.messagesError })
                        : ({
                            data: [{
                                info: {
                                    id: "assistant-1",
                                    role: "assistant",
                                    time: { created: 2 },
                                },
                                parts: [{
                                    type: "text",
                                    text: assistantText,
                                    messageID: "assistant-1",
                                    time: { start: 3, end: 4 },
                                }],
                            }],
                        })
                    ),
                }),
            },
        } as unknown as OpencodeClient
    }

    test("moves a draft job to executing and writes a solution entry", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["my_feature"] : dirPath === "/workspace/.agents/jobs/executing/my_feature" ? [] : [])

        const client = createClient("My Feature", "Execution started.") as OpencodeClient & { session: { update: ReturnType<typeof mock> } }
        const tool = createAutocodeJobStatusTool(client, fs, () => new Date("2026-05-27T10:11:12Z"))
        const parsed = JSON.parse(await tool.execute({ status: "executing" }, createToolContext()) as string)

        expect(parsed).toEqual({
            job_name: "my_feature",
            current_status: "executing",
            job_path: ".agents/jobs/executing/my_feature/",
            solution_path: ".agents/jobs/executing/my_feature/solution.md",
            next_action: "Continue the job from status executing.",
        })
        expect(fs.mkdir).toHaveBeenCalledWith("/workspace/.agents/jobs/executing", { recursive: true })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/my_feature", "/workspace/.agents/jobs/executing/my_feature")
        expect(client.session.update).toHaveBeenCalledWith({
            path: { id: "session-1" },
            query: { directory: "/workspace" },
            body: { title: "My Feature (executing)" },
        })
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/executing/my_feature/solution.md", expect.stringContaining("# 26-05-27 10:11:12 - Update Status To executing"))
    })

    test("infers the target job from session title and moves lifecycle status", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["my_feature"] : dirPath === "/workspace/.agents/jobs/executing/my_feature" ? [] : [])

        const tool = createAutocodeJobStatusTool(createClient("My Feature"), fs, () => new Date("2026-05-27T10:11:12Z"))
        const parsed = JSON.parse(await tool.execute({ status: "executing" }, createToolContext()) as string)

        expect(parsed.job_name).toBe("my_feature")
        expect(parsed.current_status).toBe("executing")
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/my_feature", "/workspace/.agents/jobs/executing/my_feature")
    })

    test("uses persisted session_id when the session title was mutated", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/executing") return ["my_feature"]
            if (dirPath === "/workspace/.agents/jobs/review/my_feature") return []
            return []
        })
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/executing/my_feature/session.yml") return "session_id: session-1\n"
            throw createMissingError()
        })

        const tool = createAutocodeJobStatusTool(createClient("Wrong Title", "Ready for review."), fs, () => new Date("2026-05-27T10:11:12Z"))
        const parsed = JSON.parse(await tool.execute({ status: "review" }, createToolContext()) as string)

        expect(parsed.job_name).toBe("my_feature")
        expect(parsed.current_status).toBe("review")
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/executing/my_feature", "/workspace/.agents/jobs/review/my_feature")
    })

    test("moves an assist job to review", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/assist" ? ["my_feature"] : dirPath === "/workspace/.agents/jobs/review/my_feature" ? [] : [])

        const client = createClient("My Feature (assist)", "Ready for review.") as OpencodeClient & { session: { update: ReturnType<typeof mock> } }
        const tool = createAutocodeJobStatusTool(client, fs, () => new Date("2026-05-27T10:11:12Z"))
        const parsed = JSON.parse(await tool.execute({ status: "review" }, createToolContext()) as string)

        expect(parsed).toEqual({
            job_name: "my_feature",
            current_status: "review",
            job_path: ".agents/jobs/review/my_feature/",
            solution_path: ".agents/jobs/review/my_feature/solution.md",
            next_action: "Continue the job from status review.",
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/assist/my_feature", "/workspace/.agents/jobs/review/my_feature")
        expect(client.session.update).toHaveBeenCalledWith({
            path: { id: "session-1" },
            query: { directory: "/workspace" },
            body: { title: "My Feature (review)" },
        })
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/review/my_feature/solution.md", expect.stringContaining("# 26-05-27 10:11:12 - Update Status To review"))
    })

    test("returns retryable identity error and does not mutate when the session title is unresolved", async () => {
        const fs = createMockFs()
        const tool = createAutocodeJobStatusTool(createClient("Missing Job", "Ready."), fs)

        const result = await tool.execute({ status: "review" }, createToolContext())

        expect(result).toBe(createLifecycleJobRequiredRetryResponse("update job status", "job missing_job"))
        expect(fs.rename).not.toHaveBeenCalled()
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("treats status review on an already-reviewed job as acceptance termination", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/review" ? ["my_feature"] : dirPath === "/workspace/.agents/jobs/terminated/my_feature" ? [] : [])

        const tool = createAutocodeJobStatusTool(createClient("My Feature", "Accepted and terminated."), fs, () => new Date("2026-05-27T10:11:12Z"))
        const parsed = JSON.parse(await tool.execute({ status: "review" }, createToolContext()) as string)

        expect(parsed).toEqual({
            job_name: "my_feature",
            current_status: "terminated",
            job_path: ".agents/jobs/terminated/my_feature/",
            solution_path: ".agents/jobs/terminated/my_feature/solution.md",
            sandbox_cleanup: expect.any(Object),
            next_action: "Termination complete; the job has no active lifecycle directory.",
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/review/my_feature", "/workspace/.agents/jobs/terminated/my_feature")
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/terminated/my_feature/solution.md", expect.stringContaining("# 26-05-27 10:11:12 - Update Status To terminated"))
    })

    test("cleans current job sandboxes when moving to terminated", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string, options?: { withFileTypes?: boolean }) => {
            if (dirPath === "/workspace/.agents/jobs/review") return ["my_feature"]
            if (dirPath === "/workspace/.agents/jobs/terminated/my_feature") return []
            if (dirPath === "/workspace/.agents/sandboxes/my_feature" && options?.withFileTypes) return [createDirent("dev"), createDirent("other")]
            return []
        })
        fs.stat.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/sandboxes/my_feature" || filePath === "/workspace/.agents/sandboxes/my_feature/dev" || filePath === "/workspace/.agents/sandboxes/my_feature/other") return { mtimeMs: Date.now() }
            return { mtimeMs: Date.now() }
        })

        const tool = createAutocodeJobStatusTool(createClient("My Feature", "Terminated."), fs, () => new Date("2026-05-27T10:11:12Z"))
        const parsed = JSON.parse(await tool.execute({ status: "terminated" }, createToolContext()) as string)

        expect(parsed.current_status).toBe("terminated")
        expect(parsed.sandbox_cleanup).toEqual(expect.objectContaining({ status: "deleted", deleted: 2, job_name: "my_feature" }))
        expect(fs.rm).toHaveBeenCalledWith("/workspace/.agents/sandboxes/my_feature/dev", { recursive: true, force: true })
        expect(fs.rm).toHaveBeenCalledWith("/workspace/.agents/sandboxes/my_feature/other", { recursive: true, force: true })
        for (const call of fs.rm.mock.calls) {
            expect(call[0]).toContain("/workspace/.agents/sandboxes/my_feature/")
            expect(call[0]).not.toContain("/workspace/.agents/jobs/")
        }
    })

    test("rejects invalid status using canonical help text", async () => {
        const fs = createMockFs()
        const tool = createAutocodeJobStatusTool(fs)

        const result = await tool.execute({ status: "drafting" }, createToolContext())

        expect(result).toBe(createRetryResponse(
            "update job status",
            "Invalid status: drafting",
            "Use one of: concepts, drafts, assist, executing, facilitate, review, terminated."
        ))
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("returns retry response when the latest assistant response has no text", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["my_feature"] : [])
        const client = {
            session: {
                get: mock(async () => ({ data: { id: "session-1", title: "My Feature", directory: "/workspace" } })),
                messages: mock(async () => ({
                    data: [{
                        info: { id: "assistant-1", role: "assistant", time: { created: 2 } },
                        parts: [],
                    }],
                })),
            },
        } as unknown as OpencodeClient
        const tool = createAutocodeJobStatusTool(client, fs)

        const result = await tool.execute({ status: "review" }, createToolContext())

        expect(result).toBe(createRetryResponse(
            "update job status",
            "No assistant response text was found in the current session.",
            "First present the user-facing lifecycle update in assistant text with concrete actions and a separate reason/evidence summary, then call autocode_job_status again."
        ))
    })

    test("returns abort response when current session messages are unavailable in this runtime", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["my_feature"] : [])
        const tool = createAutocodeJobStatusTool(createClient("My Feature", "Ready.", { includeMessages: false }), fs)

        const result = await tool.execute({ status: "review" }, createToolContext())

        expect(result).toBe(createAbortResponse(
            "inspect current session messages",
            "Current session message lookup is unavailable; autocode_job_status cannot persist the last assistant response on this runtime."
        ))
    })

    test("returns abort response when reading current session messages fails", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["my_feature"] : [])
        const tool = createAutocodeJobStatusTool(createClient("My Feature", "Ready.", { messagesError: "messages failed" }), fs)

        const result = await tool.execute({ status: "review" }, createToolContext())

        expect(result).toBe(createAbortResponse(
            "inspect current session messages",
            "Unable to read current session messages: messages failed"
        ))
    })

    test("rejects removed legacy status aliases", async () => {
        const fs = createMockFs()
        const tool = createAutocodeJobStatusTool(fs)

        const blockedResult = await tool.execute({ status: "blocked" }, createToolContext())
        const abortedResult = await tool.execute({ status: "aborted" }, createToolContext())

        expect(blockedResult).toBe(createRetryResponse(
            "update job status",
            "Invalid status: blocked",
            "Use one of: concepts, drafts, assist, executing, facilitate, review, terminated."
        ))
        expect(abortedResult).toBe(createRetryResponse(
            "update job status",
            "Invalid status: aborted",
            "Use one of: concepts, drafts, assist, executing, facilitate, review, terminated."
        ))
    })

    test("returns retry response when the job is missing", async () => {
        const fs = createMockFs()
        const tool = createAutocodeJobStatusTool(createClient("Missing Job"), fs)

        const result = await tool.execute({ status: "review" }, createToolContext())

        expect(result).toBe(createLifecycleJobRequiredRetryResponse("update job status", "job missing_job"))
    })

    test("returns lifecycle-job retry response when the job disappears before lifecycle move", async () => {
        const fs = createMockFs()
        let draftReads = 0
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/drafts") {
                draftReads += 1
                return draftReads === 1 ? ["my_feature"] : []
            }
            return []
        })
        const tool = createAutocodeJobStatusTool(createClient("My Feature", "Ready."), fs)

        const result = await tool.execute({ status: "review" }, createToolContext())

        expect(result).toBe(createLifecycleJobRequiredRetryResponse("update job status", "job my_feature"))
    })

    test("returns retry response when duplicate active lifecycle directories exist", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/drafts") return ["my_feature"]
            if (dirPath === "/workspace/.agents/jobs/review") return ["my_feature"]
            return []
        })
        const tool = createAutocodeJobStatusTool(createClient("My Feature"), fs)

        const result = await tool.execute({ status: "executing" }, createToolContext())

        expect(result).toBe(createRetryResponse(
            "update job status",
            "Planned job lifecycle collision: my_feature",
            "Resolve duplicate active lifecycle directories for this job before retrying."
        ))
    })

    test("returns retry response when destination lifecycle directory already exists", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["my_feature"] : [])
        fs.rename.mockImplementation(async () => {
            const error = new Error("exists") as NodeJS.ErrnoException
            error.code = "EEXIST"
            throw error
        })

        const tool = createAutocodeJobStatusTool(createClient("My Feature", "Ready."), fs)
        const result = await tool.execute({ status: "executing" }, createToolContext())

        expect(result).toBe(createRetryResponse(
            "update job status",
            "Destination lifecycle directory already exists for my_feature",
            "Resolve the existing lifecycle directory collision before retrying."
        ))
    })
})
