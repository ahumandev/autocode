import { describe, beforeEach, expect, mock, test } from "bun:test"
import type { Dirent } from "node:fs"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { resetRetryCounts } from "@/utils/tools"
import { createToolContext } from "./test_context"
import { createAutocodeJobStatusTool } from "./autocode_job_status"

function createMissingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

const genericNeutralResponse = { next_action: "Continue with current task." }
const retryNextAction = "Retry with a valid job status."

function parseResult(result: unknown): Record<string, unknown> {
    return JSON.parse(result as string) as Record<string, unknown>
}

function expectGenericNeutralResponse(result: unknown): void {
    expect(parseResult(result)).toEqual(genericNeutralResponse)
}

function expectNoInternalDetails(result: unknown, rawInternalStrings: string[] = []): void {
    const parsed = parseResult(result)
    expect(parsed).not.toHaveProperty("failedAction")
    expect(parsed).not.toHaveProperty("error")
    expect(parsed).not.toHaveProperty("instruction")
    for (const rawInternalString of rawInternalStrings) {
        expect(result as string).not.toContain(rawInternalString)
    }
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

    function createClient(title: string | null | undefined): OpencodeClient {
        return {
            session: {
                get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                    data: { id: args.path.id, title, directory: args.query.directory },
                })),
                update: mock(async (args: { path: { id: string }, query: { directory: string }, body: { title: string } }) => ({
                    data: { id: args.path.id, title: args.body.title, directory: args.query.directory },
                })),
            },
        } as unknown as OpencodeClient
    }

    test("moves a draft job to executing without a solution entry", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["my_feature"] : dirPath === "/workspace/.agents/jobs/executing/my_feature" ? [] : [])

        const client = createClient("My Feature") as OpencodeClient & { session: { update: ReturnType<typeof mock> } }
        const tool = createAutocodeJobStatusTool(client, fs, () => new Date("2026-05-27T10:11:12Z"))
        const parsed = parseResult(await tool.execute({ status: "executing" }, createToolContext()))

        expect(parsed).toEqual({
            next_action: "Continue the job from status executing.",
        })
        expect(fs.mkdir).toHaveBeenCalledWith("/workspace/.agents/jobs/executing", { recursive: true })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/my_feature", "/workspace/.agents/jobs/executing/my_feature")
        expect(client.session.update).toHaveBeenCalledWith({
            path: { id: "session-1" },
            query: { directory: "/workspace" },
            body: { title: "My Feature (executing)" },
        })
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("infers the target job from session title and moves lifecycle status", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["my_feature"] : dirPath === "/workspace/.agents/jobs/executing/my_feature" ? [] : [])

        const tool = createAutocodeJobStatusTool(createClient("My Feature"), fs, () => new Date("2026-05-27T10:11:12Z"))
        const parsed = parseResult(await tool.execute({ status: "executing" }, createToolContext()))

        expect(parsed.next_action).toBe("Continue the job from status executing.")
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

        const tool = createAutocodeJobStatusTool(createClient("Wrong Title"), fs, () => new Date("2026-05-27T10:11:12Z"))
        const parsed = parseResult(await tool.execute({ status: "review" }, createToolContext()))

        expect(parsed.next_action).toBe("Continue the job from status review.")
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/executing/my_feature", "/workspace/.agents/jobs/review/my_feature")
    })

    test("moves a facilitate job to review", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/facilitate" ? ["my_feature"] : dirPath === "/workspace/.agents/jobs/review/my_feature" ? [] : [])

        const client = createClient("My Feature (facilitate)") as OpencodeClient & { session: { update: ReturnType<typeof mock> } }
        const tool = createAutocodeJobStatusTool(client, fs, () => new Date("2026-05-27T10:11:12Z"))
        const parsed = parseResult(await tool.execute({ status: "review" }, createToolContext()))

        expect(parsed).toEqual({
            next_action: "Continue the job from status review.",
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/facilitate/my_feature", "/workspace/.agents/jobs/review/my_feature")
        expect(client.session.update).toHaveBeenCalledWith({
            path: { id: "session-1" },
            query: { directory: "/workspace" },
            body: { title: "My Feature (review)" },
        })
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("returns generic neutral response and does not mutate when the session title is unresolved", async () => {
        const fs = createMockFs()
        const tool = createAutocodeJobStatusTool(createClient("Missing Job"), fs)

        const result = await tool.execute({ status: "review" }, createToolContext())

        expectGenericNeutralResponse(result)
        expectNoInternalDetails(result, ["No planned job directory", "Missing Job"])
        expect(fs.rename).not.toHaveBeenCalled()
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("treats status review on an already-reviewed job as shelved", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/review" ? ["my_feature"] : dirPath === "/workspace/.agents/jobs/shelved/my_feature" ? [] : [])
        fs.stat.mockImplementation(async (filePath: string) => filePath === "/workspace/.agents/sandboxes/my_feature" ? Promise.reject(createMissingError()) : { mtimeMs: Date.now() })

        const tool = createAutocodeJobStatusTool(createClient("My Feature"), fs, () => new Date("2026-05-27T10:11:12Z"))
        const parsed = parseResult(await tool.execute({ status: "review" }, createToolContext()))

        expect(parsed).toEqual({
            next_action: "Shelve complete; the job has no active lifecycle directory.",
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/review/my_feature", "/workspace/.agents/jobs/shelved/my_feature")
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("archives current job sandboxes when moving to shelved", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string, options?: { withFileTypes?: boolean }) => {
            if (dirPath === "/workspace/.agents/jobs/review") return ["my_feature"]
            if (dirPath === "/workspace/.agents/jobs/shelved/my_feature") return []
            if (dirPath === "/workspace/.agents/sandboxes/my_feature" && options?.withFileTypes) return [createDirent("dev"), createDirent("other")]
            return []
        })
        fs.stat.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/sandboxes/my_feature" || filePath === "/workspace/.agents/sandboxes/my_feature/dev" || filePath === "/workspace/.agents/sandboxes/my_feature/other") return { mtimeMs: Date.now() }
            if (filePath === "/workspace/.agents/jobs/shelved/my_feature/sandboxes/dev" || filePath === "/workspace/.agents/jobs/shelved/my_feature/sandboxes/other") throw createMissingError()
            return { mtimeMs: Date.now() }
        })

        const tool = createAutocodeJobStatusTool(createClient("My Feature"), fs, () => new Date("2026-05-27T10:11:12Z"))
        const parsed = parseResult(await tool.execute({ status: "shelved" }, createToolContext()))

        expect(parsed.next_action).toBe("Shelve complete; the job has no active lifecycle directory.")
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/sandboxes/my_feature/dev", "/workspace/.agents/jobs/shelved/my_feature/sandboxes/dev")
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/sandboxes/my_feature/other", "/workspace/.agents/jobs/shelved/my_feature/sandboxes/other")
    })

    test("rejects invalid status using canonical help text", async () => {
        const fs = createMockFs()
        const tool = createAutocodeJobStatusTool(fs)

        const result = await tool.execute({ status: "drafting" }, createToolContext())

        expect(parseResult(result)).toEqual({
            failedAction: "update job status",
            error: "Invalid status: drafting",
            instruction: "Use one of: drafts, executing, facilitate, review, shelved.",
            next_action: retryNextAction,
        })
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("returns generic neutral response when client is missing", async () => {
        const fs = createMockFs()
        const tool = createAutocodeJobStatusTool(fs)

        const result = await tool.execute({ status: "review" }, createToolContext())

        expectGenericNeutralResponse(result)
        expectNoInternalDetails(result, ["client"])
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("rejects missing status using canonical help text", async () => {
        const fs = createMockFs()
        const tool = createAutocodeJobStatusTool(fs)

        const result = await tool.execute({}, createToolContext())

        expect(parseResult(result)).toEqual({
            failedAction: "update job status",
            error: "Invalid status: undefined",
            instruction: "Use one of: drafts, executing, facilitate, review, shelved.",
            next_action: retryNextAction,
        })
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("moves lifecycle status without session messages", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["my_feature"] : [])
        const client = {
            session: {
                get: mock(async () => ({ data: { id: "session-1", title: "My Feature", directory: "/workspace" } })),
            },
        } as unknown as OpencodeClient
        const tool = createAutocodeJobStatusTool(client, fs)

        const result = await tool.execute({ status: "review" }, createToolContext())

        expect(parseResult(result).next_action).toBe("Continue the job from status review.")
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/my_feature", "/workspace/.agents/jobs/review/my_feature")
    })

    test("rejects removed legacy final status aliases", async () => {
        const fs = createMockFs()
        const tool = createAutocodeJobStatusTool(fs)
        const instruction = "Use one of: drafts, executing, facilitate, review, shelved."
        const legacyFinalStatus = ["termi", "nated"].join("")

        const blockedResult = await tool.execute({ status: "blocked" }, createToolContext())
        const abortedResult = await tool.execute({ status: "aborted" }, createToolContext())
        const oldLifecycleResult = await tool.execute({ status: legacyFinalStatus }, createToolContext())

        for (const [legacyStatus, result] of [
            ["blocked", blockedResult],
            ["aborted", abortedResult],
            [legacyFinalStatus, oldLifecycleResult],
        ] as const) {
            expect(JSON.parse(result as string)).toEqual({
                failedAction: "update job status",
                error: `Invalid status: ${legacyStatus}`,
                instruction,
                next_action: retryNextAction,
            })
            expect(JSON.parse(result as string).instruction).not.toContain(legacyStatus)
        }
    })

    test("returns generic neutral response when the job is missing", async () => {
        const fs = createMockFs()
        const tool = createAutocodeJobStatusTool(createClient("Missing Job"), fs)

        const result = await tool.execute({ status: "review" }, createToolContext())

        expectGenericNeutralResponse(result)
        expectNoInternalDetails(result, ["No planned job directory", "Missing Job"])
    })

    test("returns generic neutral response when the job disappears before lifecycle move", async () => {
        const fs = createMockFs()
        let draftReads = 0
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/drafts") {
                draftReads += 1
                return draftReads === 1 ? ["my_feature"] : []
            }
            return []
        })
        const tool = createAutocodeJobStatusTool(createClient("My Feature"), fs)

        const result = await tool.execute({ status: "review" }, createToolContext())

        expectGenericNeutralResponse(result)
        expectNoInternalDetails(result, ["Planned job lifecycle directory is missing", "my_feature"])
    })

    test("returns generic neutral response when duplicate active lifecycle directories exist", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/drafts") return ["my_feature"]
            if (dirPath === "/workspace/.agents/jobs/review") return ["my_feature"]
            return []
        })
        const tool = createAutocodeJobStatusTool(createClient("My Feature"), fs)

        const result = await tool.execute({ status: "executing" }, createToolContext())

        expectGenericNeutralResponse(result)
        expectNoInternalDetails(result, ["Planned job lifecycle collision", "my_feature"])
    })

    test("returns generic neutral response when destination lifecycle directory already exists", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["my_feature"] : [])
        fs.rename.mockImplementation(async () => {
            const error = new Error("exists") as NodeJS.ErrnoException
            error.code = "EEXIST"
            throw error
        })

        const tool = createAutocodeJobStatusTool(createClient("My Feature"), fs)
        const result = await tool.execute({ status: "executing" }, createToolContext())

        expectGenericNeutralResponse(result)
        expectNoInternalDetails(result, ["Destination lifecycle directory already exists", "my_feature", "exists"])
    })

    test("returns generic neutral response when catch-all handler catches an internal throw", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async () => { throw new Error("secret stack internal") })
        const tool = createAutocodeJobStatusTool(createClient("My Feature"), fs)

        const result = await tool.execute({ status: "review" }, createToolContext())

        expectGenericNeutralResponse(result)
        expectNoInternalDetails(result, ["secret stack internal"])
    })
})
