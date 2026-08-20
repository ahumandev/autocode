import { describe, beforeEach, expect, mock, test } from "bun:test"
import { createAutocodeJobListTool } from "./autocode_job_list"
import { createNoopAsk } from "./test_context"
import { createAbortResponse, resetRetryCounts } from "@/utils/tools"
import type { ToolContext } from "@opencode-ai/plugin"

function parseToolResult(result: string | { output: string }) {
    return JSON.parse(typeof result === "string" ? result : result.output)
}

export function createToolContext(): ToolContext {
    return {
        sessionID: "session-1",
        messageID: "message-1",
        agent: "execute",
        directory: "/workspace",
        worktree: "/workspace",
        abort: new AbortController().signal,
        metadata() {
        },
        ask: createNoopAsk(),
    }
}

function createMissingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

describe("autocode_job_list tool", () => {
    beforeEach(() => { resetRetryCounts() })

    function createMockFs() {
        return {
            readFile: mock(async (_path: string, _encoding: "utf8") => ""),
            readdir: mock(async (_path: string, _opts?: { withFileTypes?: boolean }): Promise<string[] | import("fs").Dirent[]> => []),
        }
    }

    test("lists timestamped workspaces with statusless identities", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs"
            ? ["2026-08-20_10-30-00_job_1", "2026-08-21_10-30-00_job_2", "not-a-workspace"]
            : [])

        const tool = createAutocodeJobListTool(fs)
        const result = await tool.execute({}, createToolContext())
        const parsed = parseToolResult(result)

        expect(result).toBe(JSON.stringify({
            jobs: [
                { job_name: "job_2", job_path: ".agents/jobs/2026-08-21_10-30-00_job_2/" },
                { job_name: "job_1", job_path: ".agents/jobs/2026-08-20_10-30-00_job_1/" },
            ],
        }))
        expect(Object.keys(parsed)).toEqual(["jobs"])
    })

    test("lists jobs without reading plan content", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs" ? ["2026-08-20_10-30-00_long_job"] : [])

        const tool = createAutocodeJobListTool(fs)
        const result = await tool.execute({}, createToolContext())

        const parsed = parseToolResult(result)
        expect(parsed.jobs[0]).toEqual({
            job_name: "long_job",
            job_path: ".agents/jobs/2026-08-20_10-30-00_long_job/",
        })
    })

    test("ignores non-workspace entries", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (): Promise<string[]> => ["notes", "2026-08-20_10-30-00_", "2026-08-20_10-30-00_valid_job"])

        const tool = createAutocodeJobListTool(fs)
        const result = await tool.execute({}, createToolContext())

        const parsed = parseToolResult(result)
        expect(parsed.jobs).toEqual([
            { job_name: "valid_job", job_path: ".agents/jobs/2026-08-20_10-30-00_valid_job/" },
        ])
    })

    test("returns empty jobs if workspace directory does not exist", async () => {
        const fs = createMockFs()
        fs.readdir.mockRejectedValue(createMissingError())
        fs.readFile.mockRejectedValue(createMissingError())

        const tool = createAutocodeJobListTool(fs)
        const result = await tool.execute({}, createToolContext())

        expect(result).toBe(JSON.stringify({ jobs: [] }))
    })

    test("returns abort response on other filesystem errors", async () => {
        const fs = createMockFs()
        const error = new Error("Permission denied")
        fs.readdir.mockRejectedValue(error)

        const tool = createAutocodeJobListTool(fs)
        const result = await tool.execute({}, createToolContext())

        expect(result).toBe(createAbortResponse("list jobs", error))
    })
})
