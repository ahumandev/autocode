import { describe, beforeEach, expect, mock, test } from "bun:test"
import { createAutocodeJobListTool } from "./autocode_job_list"
import { createNoopAsk } from "./test_context"
import { createAbortResponse, createRetryResponse, resetRetryCounts } from "@/utils/tools"
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

    test("correctly lists jobs from active lifecycle directories", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/drafts") return ["job-1"]
            if (dirPath === "/workspace/.agents/jobs/executing") return ["job-2"]
            if (dirPath === "/workspace/.agents/jobs/drafts/job-1") return []
            if (dirPath === "/workspace/.agents/jobs/executing/job-2") return []
            if (dirPath === "/workspace/.agents/jobs/review") return ["job-3"]
            if (dirPath === "/workspace/.agents/jobs/review/job-3") return []
            return []
        })
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith("job-1/plan.md")) return "# Problem\n\nProblem 1\n\n---\n\n# Requirements\n\n### Requirement 1\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposed Solution\n\n"
            if (filePath.endsWith("job-2/plan.md")) return "# Problem\n\nProblem 2\n\n---\n\n# Requirements\n\n### Requirement 2\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposed Solution\n\n"
            if (filePath.endsWith("job-3/plan.md")) return "# Problem\n\nProblem 3\n\n---\n\n# Requirements\n\n### Requirement 3\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposed Solution\n\n"
            throw createMissingError()
        })

        const tool = createAutocodeJobListTool(fs)
        const result = await tool.execute({}, createToolContext())
        const parsed = parseToolResult(result)

        expect(result).toBe(JSON.stringify({
            jobs: [
                { label: "job-1", job_name: "job-1", status: "drafts", job_path: ".agents/jobs/drafts/job-1/", description: "Problem 1" },
                { label: "job-2", job_name: "job-2", status: "executing", job_path: ".agents/jobs/executing/job-2/", description: "Problem 2" },
                { label: "job-3", job_name: "job-3", status: "review", job_path: ".agents/jobs/review/job-3/", description: "Problem 3" },
            ],
        }))
        expect(Object.keys(parsed)).toEqual(["jobs"])
    })

    test("truncates first qualifying plan.md line after 80 characters", async () => {
        const fs = createMockFs()
        const longProblem = `Problem ${"a".repeat(90)}`
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/drafts" ? ["long-job"] : dirPath === "/workspace/.agents/jobs/drafts/long-job" ? [] : [])
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/drafts/long-job/plan.md") return `# Problem\n\n${longProblem}\n\n---\n\n# Requirements\n\n### Long Requirement\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposed Solution\n\n`
            throw createMissingError()
        })

        const tool = createAutocodeJobListTool(fs)
        const result = await tool.execute({}, createToolContext())

        const parsed = parseToolResult(result)
        expect(parsed.jobs[0]).toEqual({
            label: "long-job",
            job_name: "long-job",
            status: "drafts",
            job_path: ".agents/jobs/drafts/long-job/",
            description: longProblem.slice(0, 80) + "...",
        })
    })

    test("returns empty description when plan.md is missing", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/facilitate") return ["missing-plan"]
            if (dirPath === "/workspace/.agents/jobs/facilitate/missing-plan") return []
            return []
        })
        fs.readFile.mockRejectedValue(createMissingError())

        const tool = createAutocodeJobListTool(fs)
        const result = await tool.execute({}, createToolContext())

        const parsed = parseToolResult(result)
        expect(parsed.jobs).toEqual([
            { label: "missing-plan", job_name: "missing-plan", status: "facilitate", job_path: ".agents/jobs/facilitate/missing-plan/", description: "" },
        ])
    })

    for (const filter of ["concepts", "drafts", "assist", "executing", "facilitate", "review"] as const) {
        test(`filters jobs to ${filter}`, async () => {
            const fs = createMockFs()
            fs.readdir.mockImplementation(async (dirPath: string) => {
                if (dirPath === "/workspace/.agents/jobs/concepts") return ["concepts-job"]
                if (dirPath === "/workspace/.agents/jobs/drafts") return ["drafts-job"]
                if (dirPath === "/workspace/.agents/jobs/assist") return ["assist-job"]
                if (dirPath === "/workspace/.agents/jobs/executing") return ["executing-job"]
                if (dirPath === "/workspace/.agents/jobs/facilitate") return ["facilitate-job"]
                if (dirPath === "/workspace/.agents/jobs/review") return ["review-job"]
                if (dirPath === "/workspace/.agents/jobs/concepts/concepts-job") return []
                if (dirPath === "/workspace/.agents/jobs/drafts/drafts-job") return []
                if (dirPath === "/workspace/.agents/jobs/assist/assist-job") return []
                if (dirPath === "/workspace/.agents/jobs/executing/executing-job") return []
                if (dirPath === "/workspace/.agents/jobs/facilitate/facilitate-job") return []
                if (dirPath === "/workspace/.agents/jobs/review/review-job") return []
                return []
            })
            fs.readFile.mockImplementation(async (filePath: string) => {
                if (filePath.endsWith("concepts-job/plan.md")) return "# Problem\n\nConcepts problem\n\n---\n\n# Requirements\n\n### Concepts Requirement\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposed Solution\n\n"
                if (filePath.endsWith("drafts-job/plan.md")) return "# Problem\n\nDrafts problem\n\n---\n\n# Requirements\n\n### Drafts Requirement\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposed Solution\n\n"
                if (filePath.endsWith("assist-job/plan.md")) return "# Problem\n\nAssist problem\n\n---\n\n# Requirements\n\n### Assist Requirement\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposed Solution\n\n"
                if (filePath.endsWith("executing-job/plan.md")) return "# Problem\n\nExecuting problem\n\n---\n\n# Requirements\n\n### Executing Requirement\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposed Solution\n\n"
                if (filePath.endsWith("facilitate-job/plan.md")) return "# Problem\n\nFacilitate problem\n\n---\n\n# Requirements\n\n### Facilitate Requirement\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposed Solution\n\n"
                if (filePath.endsWith("review-job/plan.md")) return "# Problem\n\nReview problem\n\n---\n\n# Requirements\n\n### Review Requirement\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposed Solution\n\n"
                throw createMissingError()
            })

            const tool = createAutocodeJobListTool(fs)
            const parsed = parseToolResult(await tool.execute({ filter }, createToolContext()))

            expect(parsed.jobs).toHaveLength(1)
            expect(parsed.jobs[0].status).toBe(filter)
        })
    }

    test("returns retry response for invalid status filters", async () => {
        const fs = createMockFs()

        const tool = createAutocodeJobListTool(fs)
        const result = await tool.execute({ filter: "drafting" }, createToolContext())

        expect(result).toBe(createRetryResponse(
            "list jobs",
            "Invalid filter: drafting",
            "Omit to view all or provide one of these status filters: concepts, drafts, assist, executing, facilitate, review"
        ))
        expect(fs.readFile).not.toHaveBeenCalled()
        expect(fs.readdir).not.toHaveBeenCalled()
    })

    test("returns retry response when active lifecycle collisions are detected", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => {
            if (dirPath === "/workspace/.agents/jobs/drafts") return ["same-job"]
            if (dirPath === "/workspace/.agents/jobs/executing") return ["same-job"]
            return []
        })

        const tool = createAutocodeJobListTool(fs)
        const result = await tool.execute({}, createToolContext())

        expect(result).toBe(createRetryResponse(
            "list jobs",
            "Active lifecycle collisions detected: same-job (.agents/jobs/drafts/same-job/, .agents/jobs/executing/same-job/)",
            "Resolve the duplicate active lifecycle directories for the named job(s) before retrying."
        ))
    })

    test("returns empty jobs if lifecycle directories do not exist", async () => {
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
