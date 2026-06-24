import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { createSkillLearnCorrectionTool, createSkillLearnEnvTool, createSkillLearnPermissionTool, createSkillLearnPreferenceTool } from "./skill_learn"
import { createToolContext } from "./test_context"

type ToolResult = string | Record<string, unknown>

function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), "autocode-skill-learn-"))

    return fn(root).finally(() => {
        rmSync(root, { recursive: true, force: true })
    })
}

function parseToolResult(result: string | { output: string }): ToolResult {
    const output = typeof result === "string" ? result : result.output

    try {
        return JSON.parse(output) as Record<string, unknown>
    }
    catch {
        return output
    }
}

async function executeSkillLearn(root: string, args: Record<string, unknown>, ...agentArg: [unknown?]): Promise<ToolResult> {
    const tool = createSkillLearnCorrectionTool()
    const agent = agentArg.length === 0 ? "pair" : agentArg[0]
    const result = await tool.execute(args as never, createToolContext({
        agent: agent as never,
        directory: root,
        worktree: root,
    }))

    return parseToolResult(result)
}

function skillFilePath(root: string, agent = "pair", subject = "learned-corrections"): string {
    return join(root, ".agents", "skills", subject, agent, "SKILL.md")
}

function envSkillFilePath(root: string): string {
    return join(root, ".agents", "skills", "learned-env", "SKILL.md")
}

function permissionSkillFilePath(root: string): string {
    return join(root, ".agents", "skills", "learned-permissions", "SKILL.md")
}

function preferenceSkillFilePath(root: string): string {
    return join(root, ".agents", "skills", "learned-preferences", "SKILL.md")
}

function section(title: string, content: string): string {
    return `## ${title}\n\n${content}\n\n----------\n`
}

describe("skill_learn tool", () => {
    test("creates learned skill with frontmatter and section", async () => {
        await withTempDir(async (root) => {
            const result = await executeSkillLearn(root, {
                title: "Use bounded search",
                content: "- Search target files first.",
            })
            const filePath = skillFilePath(root)

            expect(result).toBe("OK")
            expect(readFileSync(filePath, "utf8")).toBe([
                "---",
                "name: learned-corrections/pair",
                "description: Use `learned-corrections` skill to avoid OBSTACLES, troubleshooting mistakes, recall lessons learned in previous sessions.",
                "---",
                "",
                "## Use bounded search",
                "",
                "- Search target files first.",
                "",
                "----------",
                "",
            ].join("\n"))
        })
    })

    test("primary agents write corrections under shared primary agent name", async () => {
        await withTempDir(async (root) => {
            const primaryAgents = ["assist", "auto", "design", "research"]

            for (const agent of primaryAgents) {
                const result = await executeSkillLearn(root, {
                    title: `Primary ${agent}`,
                    content: "- Share this correction.",
                }, agent)

                expect(result).toBe("OK")
            }

            const content = readFileSync(skillFilePath(root, "primary"), "utf8")

            expect(content).toContain("name: learned-corrections/primary")
            expect(content).toContain("description: Use `learned-corrections` skill to avoid OBSTACLES, troubleshooting mistakes, recall lessons learned in previous sessions.")
            for (const agent of primaryAgents) {
                expect(content).toContain(`## Primary ${agent}`)
                expect(existsSync(skillFilePath(root, agent))).toBe(false)
            }
        })
    })

    test("appends trimmed learned section after existing frontmatter and content", async () => {
        await withTempDir(async (root) => {
            const filePath = skillFilePath(root)
            mkdirSync(join(root, ".agents", "skills", "learned-corrections", "pair"), { recursive: true })
            writeFileSync(filePath, [
                "---",
                "description: Existing.",
                "---",
                "",
                section("Existing", "- Keep this."),
            ].join("\n"))

            const result = await executeSkillLearn(root, {
                title: " New lesson ",
                content: "\n- Add this.\n",
            })
            const content = readFileSync(filePath, "utf8")

            expect(result).toBe("OK")
            expect(content).toBe([
                "---",
                "description: Existing.",
                "---",
                "",
                section("Existing", "- Keep this.").trimEnd(),
                "",
                section("New lesson", "- Add this."),
            ].join("\n"))
        })
    })

    test("prunes only eldest learned section and reports final line count", async () => {
        await withTempDir(async (root) => {
            const filePath = skillFilePath(root)
            mkdirSync(join(root, ".agents", "skills", "learned-corrections", "pair"), { recursive: true })
            writeFileSync(filePath, [
                "---",
                "description: Existing.",
                "---",
                "",
                section("Eldest", "- Remove only this."),
                section("Middle", Array.from({ length: 86 }, (_, index) => `- Keep middle ${index}`).join("\n")),
            ].join("\n"))

            const result = await executeSkillLearn(root, {
                title: "Newest",
                content: "- Keep newest.",
            })
            const content = readFileSync(filePath, "utf8")

            expect(result).toBe("OK")
            expect(content).not.toContain("## Eldest")
            expect(content).toContain("## Middle")
            expect(content).toContain("## Newest")
            const lineCount = content.trimEnd().split(/\r?\n/).length
            expect(lineCount).toBeLessThanOrEqual(100)
        })
    })

    test("hard-coded env subject writes shared env storage path regardless of agent", async () => {
        await withTempDir(async (root) => {
            const tool = createSkillLearnEnvTool()
            const result = await tool.execute({
                title: "First",
                content: "- Content.",
            } as never, createToolContext({
                agent: "pair",
                directory: root,
                worktree: root,
            }))
            const secondResult = await tool.execute({
                title: "Second",
                content: "- More content.",
            } as never, createToolContext({
                agent: "reviewer",
                directory: root,
                worktree: root,
            }))
            const content = readFileSync(envSkillFilePath(root), "utf8")

            expect(parseToolResult(result)).toBe("OK")
            expect(parseToolResult(secondResult)).toBe("OK")
            expect(existsSync(envSkillFilePath(root))).toBe(true)
            expect(existsSync(skillFilePath(root, "pair", "learned-env"))).toBe(false)
            expect(existsSync(skillFilePath(root, "reviewer", "learned-env"))).toBe(false)
            expect(content).toContain("name: learned-env")
            expect(content).toContain("description: Use `learned-env` skill to find related external projects locally or recall local dev environment limitations/setup.")
            expect(content).toContain("## First")
            expect(content).toContain("## Second")
        })
    })

    test("hard-coded permission subject writes shared permissions storage path regardless of agent", async () => {
        await withTempDir(async (root) => {
            const tool = createSkillLearnPermissionTool()
            const result = await tool.execute({
                title: "First",
                content: "- Content.",
            } as never, createToolContext({
                agent: "pair",
                directory: root,
                worktree: root,
            }))
            const secondResult = await tool.execute({
                title: "Second",
                content: "- More content.",
            } as never, createToolContext({
                agent: "reviewer",
                directory: root,
                worktree: root,
            }))
            const content = readFileSync(permissionSkillFilePath(root), "utf8")

            expect(parseToolResult(result)).toBe("OK")
            expect(parseToolResult(secondResult)).toBe("OK")
            expect(existsSync(permissionSkillFilePath(root))).toBe(true)
            expect(existsSync(skillFilePath(root, "pair", "learned-permissions"))).toBe(false)
            expect(existsSync(skillFilePath(root, "reviewer", "learned-permissions"))).toBe(false)
            expect(content).toContain("name: learned-permissions")
            expect(content).toContain("description: Use `learned-permissions` skill to check if task is safe or DANGEROUS OPERATION.")
            expect(content).toContain("## First")
            expect(content).toContain("## Second")
        })
    })

    test("hard-coded preference subject writes shared preferences storage path regardless of agent", async () => {
        await withTempDir(async (root) => {
            const tool = createSkillLearnPreferenceTool()
            const result = await tool.execute({
                title: "First",
                content: "- Content.",
            } as never, createToolContext({
                agent: "pair",
                directory: root,
                worktree: root,
            }))
            const secondResult = await tool.execute({
                title: "Second",
                content: "- More content.",
            } as never, createToolContext({
                agent: "reviewer",
                directory: root,
                worktree: root,
            }))
            const content = readFileSync(preferenceSkillFilePath(root), "utf8")

            expect(parseToolResult(result)).toBe("OK")
            expect(parseToolResult(secondResult)).toBe("OK")
            expect(existsSync(preferenceSkillFilePath(root))).toBe(true)
            expect(existsSync(skillFilePath(root, "pair", "learned-preferences"))).toBe(false)
            expect(existsSync(skillFilePath(root, "reviewer", "learned-preferences"))).toBe(false)
            expect(content).toContain("name: learned-preferences")
            expect(content).toContain("description: Use `learned-preferences` skill to avoid user complaints, design better APPROACHES and improve reports.")
            expect(content).toContain("## First")
            expect(content).toContain("## Second")
        })
    })

    test("rejects subject argument without creating files", async () => {
        await withTempDir(async (root) => {
            const result = await executeSkillLearn(root, {
                subject: "other",
                title: "Title",
                content: "- Content.",
            })

            expect(result).toEqual({
                failedAction: "learn skill",
                error: "Unexpected argument(s): subject.",
                instruction: "Retry with exactly title and content arguments.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects missing and unsafe agent without creating files", async () => {
        await withTempDir(async (root) => {
            const missing = await executeSkillLearn(root, {
                title: "Title",
                content: "- Content.",
            }, undefined)
            const unsafe = await executeSkillLearn(root, {
                title: "Title",
                content: "- Content.",
            }, "../pair")

            expect(missing).toEqual({
                failedAction: "learn skill",
                error: "Missing current agent name.",
                instruction: "Retry only when tool context has a current agent name.",
            })
            expect(unsafe).toEqual({
                failedAction: "learn skill",
                error: "Unsafe current agent name: ../pair",
                instruction: "Retry only with a current agent name using letters, numbers, underscores, or hyphens.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("validates title and content without creating files", async () => {
        await withTempDir(async (root) => {
            const emptyTitle = await executeSkillLearn(root, {
                title: " ",
                content: "- Content.",
            })
            const multilineTitle = await executeSkillLearn(root, {
                title: "Bad\nTitle",
                content: "- Content.",
            })
            const emptyContent = await executeSkillLearn(root, {
                title: "Title",
                content: " ",
            })

            expect(emptyTitle).toMatchObject({
                error: "Invalid title. Title must be non-empty and contain no newline or control characters.",
            })
            expect(multilineTitle).toMatchObject({
                error: "Invalid title. Title must be non-empty and contain no newline or control characters.",
            })
            expect(emptyContent).toEqual({
                failedAction: "learn skill",
                error: "Invalid content. Content must be non-empty.",
                instruction: "Retry with learned markdown content written in Caveman English.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("returns failure shape when file creation fails", async () => {
        await withTempDir(async (root) => {
            writeFileSync(join(root, ".agents"), "not a directory")

            const result = await executeSkillLearn(root, {
                title: "Title",
                content: "- Content.",
            })

            expect(result).toMatchObject({ failedAction: "learn skill" })
            expect(result).toHaveProperty("error")
            expect(String((result as Record<string, unknown>).error)).toContain("ENOTDIR")
            expect(String((result as Record<string, unknown>).instruction)).toContain("Immediately ABORT your flow")
            expect(existsSync(skillFilePath(root))).toBe(false)
        })
    })
})
