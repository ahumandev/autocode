import { describe, expect, mock, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createRetryResponse } from "@/utils/tools"
import { createToolContext } from "./test_context"
import { createAutocodeCriteriaAcceptTool, createAutocodeCriteriaListTool, createAutocodeCriteriaRemoveTool, createAutocodeCriteriaSetTool } from "./autocode_criteria"

function parseToolResult(result: string | { output: string }) {
    return JSON.parse(typeof result === "string" ? result : result.output)
}

function createMissingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function createMockFs(content = "C1: implement feature\nC2: delegated tests\n", sessionID?: string) {
    let criteriaContent = content
    let solutionContent = "Existing log\n"
    return {
        mkdir: mock(async (_path: string, _opts?: { recursive?: boolean }) => undefined as string | undefined),
        readFile: mock(async (filePath: string, _encoding: "utf8") => {
            if (filePath === "/workspace/.agents/jobs/executing/my_feature/criteria.yml") return criteriaContent
            if (filePath === "/workspace/.agents/jobs/executing/my_feature/solution.md") return solutionContent
            if (sessionID && filePath === "/workspace/.agents/jobs/executing/my_feature/session.yml") return `session_id: ${sessionID}\n`
            throw createMissingError()
        }),
        readdir: mock(async (dirPath: string, _opts?: { withFileTypes?: boolean }) => dirPath === "/workspace/.agents/jobs/executing"
            ? ["my_feature"]
            : dirPath === "/workspace/.agents/jobs/review"
                ? ["other_feature"]
                : [] as string[]),
        writeFile: mock(async (filePath: string, nextContent: string) => {
            if (filePath === "/workspace/.agents/jobs/executing/my_feature/criteria.yml") criteriaContent = nextContent
            if (filePath === "/workspace/.agents/jobs/executing/my_feature/solution.md") solutionContent = nextContent
        }),
        appendFile: mock(async (filePath: string, appended: string) => {
            if (filePath === "/workspace/.agents/jobs/executing/my_feature/solution.md") solutionContent += appended
        }),
        get solutionContent() {
            return solutionContent
        },
    }
}

function createOnDemandFs(initialFiles: Record<string, string> = {}) {
    const files = { ...initialFiles }
    let solutionContent = files["/workspace/.agents/jobs/executing/missing_job/solution.md"] ?? ""
    return {
        mkdir: mock(async (_path: string, _opts?: { recursive?: boolean }) => undefined as string | undefined),
        readFile: mock(async (filePath: string, _encoding: "utf8") => {
            if (filePath in files) return files[filePath]
            throw createMissingError()
        }),
        readdir: mock(async (_dirPath: string, _opts?: { withFileTypes?: boolean }) => [] as string[]),
        writeFile: mock(async (filePath: string, nextContent: string) => {
            files[filePath] = nextContent
            if (filePath === "/workspace/.agents/jobs/executing/missing_job/solution.md") solutionContent = nextContent
        }),
        appendFile: mock(async (filePath: string, appended: string) => {
            files[filePath] = `${files[filePath] ?? ""}${appended}`
            if (filePath === "/workspace/.agents/jobs/executing/missing_job/solution.md") solutionContent = files[filePath]
        }),
        getFile(filePath: string) {
            return files[filePath]
        },
        get solutionContent() {
            return solutionContent
        },
    }
}

function createClient(title: string | null | undefined): OpencodeClient {
    return {
        session: {
            get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                data: { id: args.path.id, title },
            })),
        },
    } as unknown as OpencodeClient
}

describe("autocode_criteria identity behaviour", () => {
    test("lists active criteria from the inferred planned job", async () => {
        const tool = createAutocodeCriteriaListTool(createClient("My Feature"), createMockFs())
        const parsed = parseToolResult(await tool.execute({}, createToolContext()))

        expect(parsed).toMatchObject({
            job_name: "my_feature",
            criteria_path: ".agents/jobs/executing/my_feature/criteria.yml",
            empty: false,
        })
        expect(parsed.criteria).toEqual([
            { id: "C1", metric: "implement feature" },
            { id: "C2", metric: "delegated tests" },
        ])
    })

    test("set keeps criterion active for the inferred planned job", async () => {
        const fs = createMockFs()
        const tool = createAutocodeCriteriaSetTool(createClient("My Feature"), fs)
        const parsed = parseToolResult(await tool.execute({ id: "C1", metric: "updated metric" }, createToolContext()))

        expect(parsed.job_name).toBe("my_feature")
        expect(parsed.completed).toBeUndefined()
        expect(parsed.criteria).toEqual([
            { id: "C1", metric: "updated metric" },
            { id: "C2", metric: "delegated tests" },
        ])
        expect(fs.solutionContent).toBe("Existing log\n")
    })

    test("set updates criteria without touching solution evidence", async () => {
        const fs = createMockFs()
        const tool = createAutocodeCriteriaSetTool(createClient("My Feature"), fs)
        const parsed = parseToolResult(await tool.execute({ id: "C1", metric: "updated metric" }, createToolContext()))

        expect(parsed.job_name).toBe("my_feature")
        expect(parsed.completed).toBeUndefined()
        expect(parsed.criteria).toEqual([
            { id: "C1", metric: "updated metric" },
            { id: "C2", metric: "delegated tests" },
        ])
        expect(fs.solutionContent).toBe("Existing log\n")
    })

    test("accept appends evidence and removes criterion for the inferred planned job", async () => {
        const fs = createMockFs()
        const tool = createAutocodeCriteriaAcceptTool(createClient("My Feature"), fs)
        const parsed = parseToolResult(await tool.execute({ id: "C1", actions: ["changed files"], proof: "observed behavior" }, createToolContext()))

        expect(parsed).toMatchObject({
            job_name: "my_feature",
            completed: true,
            criteria_path: ".agents/jobs/executing/my_feature/criteria.yml",
            solution_path: ".agents/jobs/executing/my_feature/solution.md",
        })
        expect(parsed.criteria).toEqual([{ id: "C2", metric: "delegated tests" }])
        expect(fs.solutionContent).toContain("Accepted Criteria C1")
        expect(fs.solutionContent).toContain("## Actions\n\n- changed files")
        expect(fs.solutionContent).toContain("## Reason\n\nobserved behavior")
    })

    test("removes criteria from the inferred planned job", async () => {
        const tool = createAutocodeCriteriaRemoveTool(createClient("My Feature"), createMockFs())
        const parsed = parseToolResult(await tool.execute({ id: "C1" }, createToolContext()))

        expect(parsed.job_name).toBe("my_feature")
        expect(parsed.removed).toBe("C1")
        expect(parsed.criteria).toEqual([{ id: "C2", metric: "delegated tests" }])
    })

    test("creates an executing lifecycle dir and returns empty criteria when inferred job is missing for list", async () => {
        const listTool = createAutocodeCriteriaListTool(createClient("Missing Job"), createMockFs())

        expect(parseToolResult(await listTool.execute({}, createToolContext()))).toEqual({
            job_name: "missing_job",
            criteria_path: ".agents/jobs/executing/missing_job/criteria.yml",
            empty: true,
            criteria: [],
        })
    })

    test("creates an executing lifecycle dir when inferred job is missing for remove", async () => {
        const listTool = createAutocodeCriteriaListTool(createClient("Missing Job"), createMockFs())
        const removeTool = createAutocodeCriteriaRemoveTool(createClient("Missing Job"), createMockFs())

        expect(parseToolResult(await removeTool.execute({ id: "C1" }, createToolContext()))).toEqual({
            job_name: "missing_job",
            criteria_path: ".agents/jobs/executing/missing_job/criteria.yml",
            removed: undefined,
            criteria: [],
            track: "\n",
        })
        expect(parseToolResult(await listTool.execute({}, createToolContext()))).toEqual({
            job_name: "missing_job",
            criteria_path: ".agents/jobs/executing/missing_job/criteria.yml",
            empty: true,
            criteria: [],
        })
    })

    test("set writes criteria for the session-derived job", async () => {
        const fs = createMockFs()
        const tool = createAutocodeCriteriaSetTool(createClient("My Feature"), fs)

        const parsed = parseToolResult(await tool.execute({ id: "C1", metric: "updated metric" }, createToolContext()))

        expect(parsed.job_name).toBe("my_feature")
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/executing/my_feature/criteria.yml", "C1: updated metric\nC2: delegated tests\n")
    })

    test("set creates an executing lifecycle dir and initializes criteria on demand", async () => {
        const fs = createOnDemandFs()
        const tool = createAutocodeCriteriaSetTool(createClient("Missing Job"), fs)

        const parsed = parseToolResult(await tool.execute({ id: "C1", metric: "metric" }, createToolContext()))

        expect(parsed).toMatchObject({
            job_name: "missing_job",
            criteria_path: ".agents/jobs/executing/missing_job/criteria.yml",
            criteria: [{ id: "C1", metric: "metric" }],
        })
        expect(fs.mkdir).toHaveBeenCalledWith("/workspace/.agents/jobs/executing/missing_job", { recursive: true })
        expect(fs.writeFile.mock.calls).toEqual([
            ["/workspace/.agents/jobs/executing/missing_job/criteria.yml", "C1: metric\n"],
        ])
        expect(fs.getFile("/workspace/.agents/jobs/executing/missing_job/criteria.yml")).toBe("C1: metric\n")
    })

    test("creates an executing lifecycle dir and lists parsed criteria when the inferred job disappears", async () => {
        function createDisappearingFs() {
            let executingReads = 0
            const fs = createMockFs()
            fs.readdir.mockImplementation(async (dirPath: string, _opts?: { withFileTypes?: boolean }) => {
                if (dirPath === "/workspace/.agents/jobs/executing") {
                    executingReads += 1
                    return executingReads === 1 ? ["my_feature"] : []
                }
                return dirPath === "/workspace/.agents/jobs/review" ? ["other_feature"] : []
            })
            return fs
        }

        const fs = createDisappearingFs()

        expect(parseToolResult(await createAutocodeCriteriaListTool(createClient("My Feature"), fs).execute({}, createToolContext()))).toEqual({
            job_name: "my_feature",
            criteria_path: ".agents/jobs/executing/my_feature/criteria.yml",
            empty: false,
            criteria: [
                { id: "C1", metric: "implement feature" },
                { id: "C2", metric: "delegated tests" },
            ],
        })
        expect(fs.mkdir).toHaveBeenCalledWith("/workspace/.agents/jobs/executing/my_feature", { recursive: true })
    })

    test("accept creates the inferred executing job before reporting a missing criterion", async () => {
        const fs = createOnDemandFs()
        const tool = createAutocodeCriteriaAcceptTool(createClient("Missing Job"), fs)

        expect(await tool.execute({ id: "C1", actions: ["checked output"], proof: "not present" }, createToolContext())).toBe(
            createRetryResponse("autocode_criteria_accept", "Criterion not found: C1", "Set C1 before accepting it.")
        )
        expect(fs.mkdir).toHaveBeenCalledWith("/workspace/.agents/jobs/executing/missing_job", { recursive: true })
        expect(fs.getFile("/workspace/.agents/jobs/executing/missing_job/criteria.yml")).toBeUndefined()
        expect(fs.getFile("/workspace/.agents/jobs/executing/missing_job/solution.md")).toBeUndefined()
    })

    test("list and remove use the session-derived job when the title differs", async () => {
        const listTool = createAutocodeCriteriaListTool(createClient("Wrong Title"), createMockFs())
        const removeTool = createAutocodeCriteriaRemoveTool(createClient("Wrong Title"), createMockFs())

        expect(parseToolResult(await listTool.execute({}, createToolContext()))).toEqual({
            job_name: "wrong_title",
            criteria_path: ".agents/jobs/executing/wrong_title/criteria.yml",
            empty: true,
            criteria: [],
        })
        expect(parseToolResult(await removeTool.execute({ id: "C1" }, createToolContext()))).toEqual({
            job_name: "wrong_title",
            criteria_path: ".agents/jobs/executing/wrong_title/criteria.yml",
            removed: undefined,
            criteria: [],
            track: "\n",
        })
    })

    test("list uses persisted session_id when the session title was mutated", async () => {
        const tool = createAutocodeCriteriaListTool(createClient("Wrong Title"), createMockFs(undefined, "session-1"))

        const parsed = parseToolResult(await tool.execute({}, createToolContext()))

        expect(parsed).toMatchObject({
            job_name: "my_feature",
            criteria_path: ".agents/jobs/executing/my_feature/criteria.yml",
            empty: false,
        })
    })
})
