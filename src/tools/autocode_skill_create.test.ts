import { afterEach, describe, expect, test } from "bun:test"
import { resetRetryCounts } from "@/utils/tools"
import { createAutocodeSkillCreateTool } from "./autocode_skill_create"
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

describe("skill_create", () => {
    afterEach(() => {
        resetRetryCounts()
    })

    test("creates SKILL.md and returns relative path", async () => {
        const fs = createFakeFileSystem()
        const skillTool = createAutocodeSkillCreateTool(fs)

        const result = await skillTool.execute(
            { name: "code-typescript", description: "Use code-typescript when writing TS." } as never,
            createToolContext({ directory: "/workspace", worktree: "/workspace" }),
        )

        expect(result).toBe(".agents/skills/code-typescript/SKILL.md")
        expect(fs.hasDir("/workspace/.agents/skills/code-typescript")).toBe(true)
        const content = fs.getFile("/workspace/.agents/skills/code-typescript/SKILL.md")
        expect(content).toContain("name: code-typescript")
        expect(content).toContain("description: Use code-typescript when writing TS.")
    })

    test("returns retry when name is blank", async () => {
        const skillTool = createAutocodeSkillCreateTool(createFakeFileSystem())
        const result = await skillTool.execute(
            { name: "   ", description: "trigger" } as never,
            createToolContext(),
        )
        const parsed = JSON.parse(result as string)
        expect(parsed.failedAction).toBe("create skill")
    })

    test("returns retry when description is blank", async () => {
        const skillTool = createAutocodeSkillCreateTool(createFakeFileSystem())
        const result = await skillTool.execute(
            { name: "code-foo", description: "" } as never,
            createToolContext(),
        )
        const parsed = JSON.parse(result as string)
        expect(parsed.failedAction).toBe("create skill")
    })

    test("returns abort when writeFile fails", async () => {
        const failingFs = {
            mkdir: async () => undefined,
            writeFile: async () => { throw new Error("disk full") },
        }
        const skillTool = createAutocodeSkillCreateTool(failingFs)
        const result = await skillTool.execute(
            { name: "code-foo", description: "trigger" } as never,
            createToolContext(),
        )
        const parsed = JSON.parse(result as string)
        expect(parsed.failedAction).toBe("create skill")
    })
})
