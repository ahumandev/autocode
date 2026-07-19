import { afterEach, describe, expect, test } from "bun:test"
import { resetRetryCounts } from "@/utils/tools"
import { createAutocodeSkillEditTool } from "./skill_edit"
import { createToolContext } from "./test_context"

function createFakeFileSystem() {
    const files = new Map<string, string>()
    const dirs = new Set<string>()
    return {
        async mkdir(dirPath: string) {
            dirs.add(dirPath)
        },
        async writeFile(filePath: string, content: string) {
            files.set(filePath, content)
        },
        getFile: (p: string) => files.get(p),
        hasDir: (p: string) => dirs.has(p),
    }
}

describe("skill_edit", () => {
    afterEach(() => {
        resetRetryCounts()
    })

    test("creates SKILL.md and returns relative path", async () => {
        const fs = createFakeFileSystem()
        const skillTool = createAutocodeSkillEditTool(fs)

        const result = await skillTool.execute(
            { name: "code-typescript", description: "Use code-typescript when writing TS.", content: "# Steps\nDo thing." } as never,
            createToolContext({ directory: "/workspace", worktree: "/workspace" }),
        )

        expect(result).toBe(".agents/skills/code-typescript/SKILL.md")
        expect(fs.hasDir("/workspace/.agents/skills/code-typescript")).toBe(true)
        const content = fs.getFile("/workspace/.agents/skills/code-typescript/SKILL.md")
        expect(content).toContain("name: code-typescript")
        expect(content).toContain("description: Use code-typescript when writing TS.")
        expect(content).toContain("# Steps\nDo thing.")
    })

    test("returns retry when name is blank", async () => {
        const skillTool = createAutocodeSkillEditTool(createFakeFileSystem())
        const result = await skillTool.execute(
            { name: "   ", description: "trigger", content: "body" } as never,
            createToolContext(),
        )
        const parsed = JSON.parse(result as string)
        expect(parsed.failedAction).toBe("edit skill")
    })

    test("returns retry when description is blank", async () => {
        const skillTool = createAutocodeSkillEditTool(createFakeFileSystem())
        const result = await skillTool.execute(
            { name: "code-foo", description: "", content: "body" } as never,
            createToolContext(),
        )
        const parsed = JSON.parse(result as string)
        expect(parsed.failedAction).toBe("edit skill")
    })

    test("returns retry when content is blank", async () => {
        const skillTool = createAutocodeSkillEditTool(createFakeFileSystem())
        const result = await skillTool.execute(
            { name: "code-foo", description: "trigger", content: "   " } as never,
            createToolContext(),
        )
        const parsed = JSON.parse(result as string)
        expect(parsed.failedAction).toBe("edit skill")
    })

    test("returns abort when writeFile fails", async () => {
        const failingFs = {
            mkdir: async () => undefined,
            writeFile: async () => { throw new Error("disk full") },
        }
        const skillTool = createAutocodeSkillEditTool(failingFs)
        const result = await skillTool.execute(
            { name: "code-foo", description: "trigger", content: "body" } as never,
            createToolContext(),
        )
        const parsed = JSON.parse(result as string)
        expect(parsed.failedAction).toBe("edit skill")
    })
})
