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
        async readFile(filePath: string) {
            const content = files.get(filePath)
            if (content === undefined) {
                const error = new Error("not found") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            }
            return content
        },
        async rm(filePath: string) {
            files.delete(filePath)
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
            readFile: async () => { throw new Error("disk full") },
            rm: async () => undefined,
        }
        const skillTool = createAutocodeSkillEditTool(failingFs)
        const result = await skillTool.execute(
            { name: "code-foo", description: "trigger", content: "body" } as never,
            createToolContext(),
        )
        const parsed = JSON.parse(result as string)
        expect(parsed.failedAction).toBe("edit skill")
    })

    test("adds references creating files and a References section", async () => {
        const fs = createFakeFileSystem()
        const skillTool = createAutocodeSkillEditTool(fs)

        await skillTool.execute(
            {
                name: "code-typescript",
                description: "trigger",
                content: "body",
                references: [
                    { description: "Template file", path: "templates/foo.txt", content: "hello" },
                ],
            } as never,
            createToolContext({ directory: "/workspace", worktree: "/workspace" }),
        )

        expect(fs.getFile("/workspace/.agents/skills/code-typescript/templates/foo.txt")).toBe("hello")
        const skillMd = fs.getFile("/workspace/.agents/skills/code-typescript/SKILL.md")
        expect(skillMd).toContain("## References")
        expect(skillMd).toContain("* [Template file](templates/foo.txt)")
    })

    test("deleting a reference removes file and entry", async () => {
        const fs = createFakeFileSystem()
        const skillTool = createAutocodeSkillEditTool(fs)

        await skillTool.execute(
            {
                name: "code-typescript",
                description: "trigger",
                content: "body",
                references: [
                    { description: "Template file", path: "templates/foo.txt", content: "hello" },
                    { description: "Other", path: "templates/bar.txt", content: "world" },
                ],
            } as never,
            createToolContext({ directory: "/workspace", worktree: "/workspace" }),
        )

        await skillTool.execute(
            {
                name: "code-typescript",
                description: "trigger",
                content: "body",
                references: [
                    { description: "Template file", path: "templates/foo.txt", content: "[delete]" },
                ],
            } as never,
            createToolContext({ directory: "/workspace", worktree: "/workspace" }),
        )

        expect(fs.getFile("/workspace/.agents/skills/code-typescript/templates/foo.txt")).toBeUndefined()
        const skillMd = fs.getFile("/workspace/.agents/skills/code-typescript/SKILL.md")
        expect(skillMd).not.toContain("templates/foo.txt")
        expect(skillMd).toContain("templates/bar.txt")
    })

    test("deleting all references removes References section entirely", async () => {
        const fs = createFakeFileSystem()
        const skillTool = createAutocodeSkillEditTool(fs)

        await skillTool.execute(
            {
                name: "code-typescript",
                description: "trigger",
                content: "body",
                references: [
                    { description: "Template file", path: "templates/foo.txt", content: "hello" },
                ],
            } as never,
            createToolContext({ directory: "/workspace", worktree: "/workspace" }),
        )

        await skillTool.execute(
            {
                name: "code-typescript",
                description: "trigger",
                content: "body",
                references: [
                    { description: "Template file", path: "templates/foo.txt", content: "[delete]" },
                ],
            } as never,
            createToolContext({ directory: "/workspace", worktree: "/workspace" }),
        )

        const skillMd = fs.getFile("/workspace/.agents/skills/code-typescript/SKILL.md")
        expect(skillMd).not.toContain("## References")
    })

    test("no references arg leaves SKILL.md without References section", async () => {
        const fs = createFakeFileSystem()
        const skillTool = createAutocodeSkillEditTool(fs)

        await skillTool.execute(
            { name: "code-typescript", description: "trigger", content: "body" } as never,
            createToolContext({ directory: "/workspace", worktree: "/workspace" }),
        )

        const skillMd = fs.getFile("/workspace/.agents/skills/code-typescript/SKILL.md")
        expect(skillMd).not.toContain("## References")
    })
})
