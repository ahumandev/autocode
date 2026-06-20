import { describe, expect, mock, test } from "bun:test"
import { createSolutionUtils, readLatestSolutionStatus, SolutionLogEvent } from "./solution"

function createMissingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

describe("solution utils", () => {
    test("appends guarded solution entries with the requested format", async () => {
        let solutionContent = "Existing log\n"
        const fileSystem = {
            mkdir: mock(async (_path: string, _opts?: { recursive?: boolean }) => undefined as string | undefined),
            readFile: mock(async (filePath: string) => {
                if (filePath === "/workspace/.agents/jobs/executing/my_feature/solution.md") return solutionContent
                throw createMissingError()
            }),
            readdir: mock(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/executing/my_feature" ? [] as string[] : [] as string[]),
            appendFile: mock(async (_filePath: string, content: string) => {
                solutionContent += content
            }),
            writeFile: mock(async (filePath: string, content: string) => {
                if (filePath === "/workspace/.agents/jobs/executing/my_feature/solution.md") solutionContent = content
            }),
        }

        const solution = createSolutionUtils(fileSystem, "/workspace", {
            getDirectory: async () => "executing",
            now: () => new Date("2026-05-27T10:11:12Z"),
        })
        const logged = await solution.log("my_feature", SolutionLogEvent.UpdateStatus, "facilitate", "changed files\nverified output", "status reason")

        expect(logged.relativeSolutionPath).toBe(".agents/jobs/executing/my_feature/solution.md")
        expect(solutionContent).toContain("# 26-05-27 10:11:12 - Update Status To facilitate")
        expect(solutionContent).toContain("## Actions\n\n- changed files\n- verified output")
        expect(solutionContent).toContain("## Reason\n\nstatus reason")
        expect(solutionContent).toContain("---")
    })

    test("reads the latest logged status from solution.md", () => {
        const content = [
            "# 26-05-27 10:11:12 - Update Status To facilitate",
            "",
            "## Actions",
            "",
            "- paused",
            "",
            "## Reason",
            "",
            "waiting on review",
            "",
            "---",
            "",
            "# 26-05-27 11:11:12 - Note",
            "",
            "## Actions",
            "",
            "- shipped",
            "",
            "## Reason",
            "",
            "done",
            "",
            "---",
            "",
            "# 26-05-27 12:11:12 - Update Status To facilitate",
        ].join("\n")

        expect(readLatestSolutionStatus(content, ["facilitate"])).toBe("facilitate")
    })
})
