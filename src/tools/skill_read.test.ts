import { afterEach, describe, expect, test } from "bun:test"
import { resetRetryCounts } from "@/utils/tools"
import { createAutocodeSkillReadTool } from "./skill_read"
import { createToolContext } from "./test_context"

function createFakeFileSystem() {
    const files = new Map<string, string>()
    return {
        async readFile(filePath: string) {
            if (!files.has(filePath)) {
                const error: NodeJS.ErrnoException = new Error(`ENOENT: ${filePath}`)
                error.code = "ENOENT"
                throw error
            }
            return files.get(filePath) ?? ""
        },
        setFile: (p: string, content: string) => files.set(p, content),
    }
}

describe("skill_read", () => {
    afterEach(() => {
        resetRetryCounts()
    })

    test("reads SKILL.md and returns content", async () => {
        const fs = createFakeFileSystem()
        const body = "# Steps\nDo thing."
        const fileContent = `---\nname: code-typescript\ndescription: Use code-typescript when writing TS.\n---\n\n${body}\n`
        fs.setFile("/workspace/.agents/skills/code-typescript/SKILL.md", fileContent)

        const skillTool = createAutocodeSkillReadTool(fs)
        const result = await skillTool.execute(
            { name: "code-typescript" } as never,
            createToolContext({ directory: "/workspace", worktree: "/workspace" }),
        )

        expect(result).toBe(fileContent)
        expect(result).toContain("name: code-typescript")
        expect(result).toContain("description: Use code-typescript when writing TS.")
        expect(result).toContain(body)
    })

    test("returns retry when name is blank", async () => {
        const skillTool = createAutocodeSkillReadTool(createFakeFileSystem())
        const result = await skillTool.execute(
            { name: "   " } as never,
            createToolContext(),
        )
        const parsed = JSON.parse(result as string)
        expect(parsed.failedAction).toBe("read skill")
    })
})
