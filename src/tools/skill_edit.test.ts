import { afterEach, describe, expect, test } from "bun:test"
import { resetRetryCounts } from "@/utils/tools"
import { AGENT_SKILL_MAP, createAutocodeSkillEditTool } from "./skill_edit"
import { createToolContext } from "./test_context"

function createFakeFileSystem() {
    const files = new Map<string, string>()
    const dirs = new Set<string>()
    return {
        async mkdir(dirPath: string): Promise<string | undefined> {
            dirs.add(dirPath)
            return undefined
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
            mkdir: async (): Promise<string | undefined> => undefined,
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

    describe("AGENT_SKILL_MAP override", () => {
        // Lock the expected agent -> skill mapping. Updating this map without
        // updating these assertions should fail the regression suite.
        const expectedMappings: Record<string, string> = {
            "document_conventions": "design-conventions",
            "document_code": "execute-code",
            "document_install": "execute-install",
            "document_prd": "design-prd",
            "document_ux": "execute-ux",
        }

        test("AGENT_SKILL_MAP exports the expected agent -> skill mapping", () => {
            expect(AGENT_SKILL_MAP).toEqual(expectedMappings)
        })

        test("document_code overrides any args.name to execute-code", async () => {
            const fs = createFakeFileSystem()
            const skillTool = createAutocodeSkillEditTool(fs)

            const result = await skillTool.execute(
                { name: "anything", description: "trigger", content: "body" } as never,
                createToolContext({ agent: "document_code", directory: "/workspace", worktree: "/workspace" }),
            )

            expect(result).toBe(".agents/skills/execute-code/SKILL.md")
            expect(fs.hasDir("/workspace/.agents/skills/execute-code")).toBe(true)
            const content = fs.getFile("/workspace/.agents/skills/execute-code/SKILL.md")
            expect(content).toContain("name: execute-code")
            expect(content).not.toContain("anything")
            // No skill dir created under the original args.name
            expect(fs.hasDir("/workspace/.agents/skills/anything")).toBe(false)
        })

        test.each(Object.entries(expectedMappings))(
            "agent %s overrides args.name to %s",
            async (agent, skillName) => {
                const fs = createFakeFileSystem()
                const skillTool = createAutocodeSkillEditTool(fs)

                const result = await skillTool.execute(
                    { name: "should-be-overridden", description: "trigger", content: "body" } as never,
                    createToolContext({ agent, directory: "/workspace", worktree: "/workspace" }),
                )

                expect(result).toBe(`.agents/skills/${skillName}/SKILL.md`)
                expect(fs.hasDir(`/workspace/.agents/skills/${skillName}`)).toBe(true)
                expect(fs.hasDir("/workspace/.agents/skills/should-be-overridden")).toBe(false)
                const content = fs.getFile(`/workspace/.agents/skills/${skillName}/SKILL.md`)
                expect(content).toContain(`name: ${skillName}`)
            },
        )

        test("unmapped agent uses args.name as-is", async () => {
            const fs = createFakeFileSystem()
            const skillTool = createAutocodeSkillEditTool(fs)

            const result = await skillTool.execute(
                { name: "custom-skill", description: "trigger", content: "body" } as never,
                createToolContext({ agent: "primary", directory: "/workspace", worktree: "/workspace" }),
            )

            expect(result).toBe(".agents/skills/custom-skill/SKILL.md")
            expect(fs.hasDir("/workspace/.agents/skills/custom-skill")).toBe(true)
            const content = fs.getFile("/workspace/.agents/skills/custom-skill/SKILL.md")
            expect(content).toContain("name: custom-skill")
        })

        test("unmapped agent with blank name still rejected after fall-through", async () => {
            const skillTool = createAutocodeSkillEditTool(createFakeFileSystem())
            const result = await skillTool.execute(
                { name: "   ", description: "trigger", content: "body" } as never,
                createToolContext({ agent: "primary" }),
            )
            const parsed = JSON.parse(result as string)
            expect(parsed.failedAction).toBe("edit skill")
        })
    })
})
