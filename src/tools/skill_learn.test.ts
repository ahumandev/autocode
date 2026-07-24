import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
    createSkillLearnTool,
    validateSkillLearnArgs,
} from "./skill_learn"
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
    } catch {
        return output
    }
}

type SubjectDir = "corrections" | "env" | "permissions" | "preferences"

function learnedSkillFile(root: string, subject: SubjectDir, dirName: string): string {
    return join(root, ".agents", "skills", `learned-${subject}`, dirName, "SKILL.md")
}

function learnedSkillDir(root: string, subject: SubjectDir): string {
    return join(root, ".agents", "skills", `learned-${subject}`)
}

function listLearnedDirs(root: string, subject: SubjectDir): string[] {
    const dir = learnedSkillDir(root, subject)
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
}

function executeTool(
    root: string,
    args: Record<string, unknown>,
    agent = "pair",
): Promise<ToolResult> {
    const tool = createSkillLearnTool()
    return tool.execute(args as never, createToolContext({
        agent,
        directory: root,
        worktree: root,
    })).then((result) => parseToolResult(result as never))
}

function executeCorrectionTool(root: string, args: Record<string, unknown>): Promise<ToolResult> {
    return executeTool(root, { category: "correction", ...args })
}

const DEFAULT_DESCRIPTION = "Mistake was corrected by using bounded search."

describe("skill_learn tool validation", () => {
    test("rejects missing category", async () => {
        await withTempDir(async (root) => {
            const result = await executeTool(root, {
                name: "Title",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(result).toMatchObject({
                failedAction: "learn skill",
                error: "Invalid category: \"undefined\". Must be one of: correction, env, permission, preference.",
                instruction: "Retry with a valid category argument.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects invalid category value", async () => {
        await withTempDir(async (root) => {
            const result = await executeTool(root, {
                category: "other",
                name: "Title",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(result).toMatchObject({
                failedAction: "learn skill",
                error: "Invalid category: \"other\". Must be one of: correction, env, permission, preference.",
                instruction: "Retry with a valid category argument.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects subject argument without creating files", async () => {
        await withTempDir(async (root) => {
            const result = await executeCorrectionTool(root, {
                subject: "other",
                name: "Title",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(result).toEqual({
                failedAction: "learn skill",
                error: "Unexpected argument(s): subject.",
                instruction: "Retry with category, name, content, description, key, and references arguments.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects non-string key without creating files", async () => {
        await withTempDir(async (root) => {
            const result = await executeTool(root, {
                category: "env",
                name: "Title",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
                key: 123,
            })

            expect(result).toEqual({
                failedAction: "learn skill",
                error: "Invalid key. Key must be a string when provided.",
                instruction: "Retry with key omitted, blank, or using letters, numbers, underscores, or hyphens.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects unsafe key without creating files", async () => {
        await withTempDir(async (root) => {
            const result = await executeTool(root, {
                category: "env",
                name: "Title",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
                key: "../pair",
            })

            expect(result).toMatchObject({
                error: "Unsafe key: ../pair",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("validates name without creating files", async () => {
        await withTempDir(async (root) => {
            const emptyName = await executeCorrectionTool(root, {
                name: " ",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
            })
            const multilineName = await executeCorrectionTool(root, {
                name: "Bad\nName",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(emptyName).toMatchObject({
                error: "Invalid name. Name must be non-empty and contain no newline or control characters.",
            })
            expect(multilineName).toMatchObject({
                error: "Invalid name. Name must be non-empty and contain no newline or control characters.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects missing or blank description without creating files", async () => {
        await withTempDir(async (root) => {
            const missingDescription = await executeCorrectionTool(root, {
                name: "Title",
                content: "- Content.",
            })
            const blankDescription = await executeCorrectionTool(root, {
                name: "Title",
                content: "- Content.",
                description: "   ",
            })

            for (const result of [missingDescription, blankDescription]) {
                expect(result).toMatchObject({
                    error: "description required for new skill",
                    instruction: "Retry with a trigger description on one line that describes when to use this skill.",
                })
            }
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects description with control characters without creating files", async () => {
        await withTempDir(async (root) => {
            const multilineDescription = await executeCorrectionTool(root, {
                name: "Title",
                content: "- Content.",
                description: "Bad\nDescription",
            })

            expect(multilineDescription).toMatchObject({
                error: "Invalid description. Description must be non-empty and contain no newline or control characters.",
                instruction: "Retry with a trigger description on one line that describes when to use this skill.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects empty content without creating files", async () => {
        await withTempDir(async (root) => {
            const emptyContent = await executeCorrectionTool(root, {
                name: "Title",
                content: " ",
                description: DEFAULT_DESCRIPTION,
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

            const result = await executeCorrectionTool(root, {
                name: "Title",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(result).toMatchObject({ failedAction: "learn skill" })
            expect(result).toHaveProperty("error")
            expect(String((result as Record<string, unknown>).error)).toContain("ENOTDIR")
            expect(String((result as Record<string, unknown>).instruction)).toContain("Immediately ABORT your flow")
        })
    })
})

describe("skill_learn per-item directory", () => {
    test("creates a per-item learned-corrections dir with frontmatter and body", async () => {
        await withTempDir(async (root) => {
            const result = await executeCorrectionTool(root, {
                name: "Avoid re-render",
                content: "- Wrap component in useMemo.",
                description: "Use this skill when a component re-renders unnecessarily.",
            })

            expect(result).toBe("OK")
            const expectedDir = "learned-correction-avoid-re-render"
            const filePath = learnedSkillFile(root, "corrections", expectedDir)

            expect(existsSync(filePath)).toBe(true)
            expect(readFileSync(filePath, "utf8")).toBe([
                "---",
                `name: ${expectedDir}`,
                "description: Use this skill when a component re-renders unnecessarily.",
                "---",
                "",
                "- Wrap component in useMemo.",
                "",
                "---",
                "",
                `Content outdated? Call \`skill_learn\` with name=\`${expectedDir}\` to correct.`,
                "",
            ].join("\n"))
            expect(listLearnedDirs(root, "corrections")).toEqual([expectedDir])
        })
    })

    test("env tool writes per-item dir with key segment in dir name", async () => {
        await withTempDir(async (root) => {
            const result = await executeTool(root, {
                category: "env",
                name: "Remote host A",
                content: "- Remote detail.",
                description: "Use this skill when SSH-ing into prod host A.",
                key: "Prod-Key",
            })

            expect(result).toBe("OK")
            const expectedDir = "learned-env-prod-key-remote-host-a"
            const filePath = learnedSkillFile(root, "env", expectedDir)

            expect(existsSync(filePath)).toBe(true)
            const content = readFileSync(filePath, "utf8")
            expect(content).toContain(`name: ${expectedDir}`)
            expect(content).not.toMatch(/^## /m)
            expect(content.endsWith(`- Remote detail.\n\n---\n\nContent outdated? Call \`skill_learn\` with name=\`${expectedDir}\` to correct.\n`)).toBe(true)
            expect(listLearnedDirs(root, "env")).toEqual([expectedDir])
        })
    })

    test("env tool without key omits key segment from dir name", async () => {
        await withTempDir(async (root) => {
            const result = await executeTool(root, {
                category: "env",
                name: "Local dev",
                content: "- Local detail.",
                description: "Use this skill when local dev env limited.",
            })

            expect(result).toBe("OK")
            const expectedDir = "learned-env-local-dev"
            expect(existsSync(learnedSkillFile(root, "env", expectedDir))).toBe(true)
        })
    })

    test("accepts key for non-env category", async () => {
        await withTempDir(async (root) => {
            const result = await executeCorrectionTool(root, {
                name: "Remote fix",
                content: "- Fixed remote issue.",
                description: "Use this skill when fixing remote host issue.",
                key: "host-a",
            })

            expect(result).toBe("OK")
            const expectedDir = "learned-correction-host-a-remote-fix"
            expect(existsSync(learnedSkillFile(root, "corrections", expectedDir))).toBe(true)
            expect(listLearnedDirs(root, "corrections")).toEqual([expectedDir])
        })
    })

    test("truncates topic to 40 chars when name is long", async () => {
        await withTempDir(async (root) => {
            const longTopic = "a".repeat(60)
            const result = await executeCorrectionTool(root, {
                name: longTopic,
                content: "- Long content.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(result).toBe("OK")
            const truncated = "a".repeat(40)
            const expectedDir = `learned-correction-${truncated}`

            expect(listLearnedDirs(root, "corrections")).toEqual([expectedDir])
            expect(existsSync(learnedSkillFile(root, "corrections", expectedDir))).toBe(true)
        })
    })

    test("falls back to untitled topic for non-alphanumeric name", async () => {
        await withTempDir(async (root) => {
            const result = await executeCorrectionTool(root, {
                name: "!!!",
                content: "- No usable chars.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(result).toBe("OK")
            const expectedDir = "learned-correction-untitled"

            expect(listLearnedDirs(root, "corrections")).toEqual([expectedDir])
        })
    })

    test("calling twice with same name overwrites (updates) existing skill", async () => {
        await withTempDir(async (root) => {
            const first = await executeCorrectionTool(root, {
                name: "Avoid re-render",
                content: "- First call.",
                description: DEFAULT_DESCRIPTION,
            })
            const second = await executeCorrectionTool(root, {
                name: "Avoid re-render",
                content: "- Second call.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(first).toBe("OK")
            expect(second).toBe("OK")

            const skillDir = "learned-correction-avoid-re-render"
            expect(listLearnedDirs(root, "corrections")).toEqual([skillDir])
            const filePath = learnedSkillFile(root, "corrections", skillDir)
            expect(existsSync(filePath)).toBe(true)
            const fileContent = readFileSync(filePath, "utf8")
            expect(fileContent).toContain("- Second call.")
            expect(fileContent).not.toContain("- First call.")
            expect(fileContent).toContain(`name: ${skillDir}`)
        })
    })

    test("frontmatter description equals argument verbatim and name equals dir basename", async () => {
        await withTempDir(async (root) => {
            const description = "Trigger-focused when X then Y."
            await executeCorrectionTool(root, {
                name: "Trigger title",
                content: "- Lesson.",
                description,
            })

            const dirName = "learned-correction-trigger-title"
            const content = readFileSync(learnedSkillFile(root, "corrections", dirName), "utf8")

            expect(content).toContain(`name: ${dirName}`)
            expect(content).toContain(`description: ${description}`)
        })
    })

    test("does not append or prune — each invocation writes a single isolated section", async () => {
        await withTempDir(async (root) => {
            await executeCorrectionTool(root, {
                name: "First",
                content: "- First.",
                description: DEFAULT_DESCRIPTION,
            })
            await executeCorrectionTool(root, {
                name: "Second",
                content: "- Second.",
                description: DEFAULT_DESCRIPTION,
            })

            const dirs = listLearnedDirs(root, "corrections")
            expect(dirs).toEqual([
                "learned-correction-first",
                "learned-correction-second",
            ])
            for (const dir of dirs) {
                const content = readFileSync(learnedSkillFile(root, "corrections", dir), "utf8")
                expect(content).not.toMatch(/^## /m)
                expect(content.endsWith(`Content outdated? Call \`skill_learn\` with name=\`${dir}\` to correct.\n`)).toBe(true)
            }
        })
    })

    test("permission category writes per-item permission skill dir", async () => {
        await withTempDir(async (root) => {
            const result = await executeTool(root, {
                category: "permission",
                name: "Safe delete",
                content: "- Safe action.",
                description: "Use this skill when deleting files manually.",
            })

            expect(result).toBe("OK")
            expect(listLearnedDirs(root, "permissions")).toEqual([
                "learned-permission-safe-delete",
            ])
        })
    })

    test("preference category writes per-item preference skill dir", async () => {
        await withTempDir(async (root) => {
            const result = await executeTool(root, {
                category: "preference",
                name: "Prefer tabs",
                content: "- Use tabs.",
                description: "Use this skill when a reviewer complains about indentation.",
            })

            expect(result).toBe("OK")
            expect(listLearnedDirs(root, "preferences")).toEqual([
                "learned-preference-prefer-tabs",
            ])
        })
    })

    test("validateSkillLearnArgs trims name, content, and description", () => {
        const result = validateSkillLearnArgs({
            category: "correction",
            name: " Spaced Name ",
            content: "\n- Body.\n",
            description: " Trigger here ",
        })
        expect(result).toEqual({
            category: "correction",
            name: "Spaced Name",
            content: "- Body.",
            description: "Trigger here",
            key: undefined,
        })
    })

    test("validateSkillLearnArgs normalizes key to lowercased trim", () => {
        const result = validateSkillLearnArgs({
            category: "env",
            name: "Title",
            content: "- Body.",
            description: "Trigger.",
            key: "  Prod-Key  ",
        })
        expect(result).toMatchObject({ key: "prod-key" })
    })
})

describe("skill_learn old-format legacy dirs not touched", () => {
    test("legacy learned-corrections-pair skill dir at skills root remains after cleanup", async () => {
        await withTempDir(async (root) => {
            // Simulate legacy pre-rewrite shape: single skill dir at skills root.
            const legacyDir = join(root, ".agents", "skills", "learned-corrections-pair")
            mkdirSync(legacyDir, { recursive: true })
            writeFileSync(join(legacyDir, "SKILL.md"), "---\nname: legacy\n---\n# Legacy\n")
            await executeCorrectionTool(root, {
                name: "New lesson",
                content: "- New.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(existsSync(join(legacyDir, "SKILL.md"))).toBe(true)
            expect(readdirSync(join(root, ".agents", "skills")).sort()).toEqual([
                "learned-corrections",
                "learned-corrections-pair",
            ])
        })
    })
})

describe("skill_learn optional description when skill exists", () => {
    test("new skill missing description returns retry error", async () => {
        await withTempDir(async (root) => {
            const result = await executeCorrectionTool(root, {
                name: "Brand new skill",
                content: "- Fresh content.",
            })

            expect(result).toMatchObject({
                failedAction: "learn skill",
                error: "description required for new skill",
                instruction: "Retry with a trigger description on one line that describes when to use this skill.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("existing skill with description omitted keeps old description and updates body", async () => {
        await withTempDir(async (root) => {
            const originalDescription = "Use this skill when a hook fires twice."
            const first = await executeCorrectionTool(root, {
                name: "Double hook",
                content: "- First content.",
                description: originalDescription,
            })
            expect(first).toBe("OK")

            const skillDir = "learned-correction-double-hook"
            const filePath = learnedSkillFile(root, "corrections", skillDir)

            // Second call: omit description, update content only.
            const second = await executeCorrectionTool(root, {
                name: "Double hook",
                content: "- Updated content.",
            })
            expect(second).toBe("OK")

            const fileContent = readFileSync(filePath, "utf8")
            // Old description preserved from existing file.
            expect(fileContent).toContain(`description: ${originalDescription}`)
            // Body content updated.
            expect(fileContent).toContain("- Updated content.")
            expect(fileContent).not.toContain("- First content.")
            // Outdated instruction present.
            expect(fileContent).toContain(`Content outdated? Call \`skill_learn\` with name=\`${skillDir}\` to correct.`)
            expect(listLearnedDirs(root, "corrections")).toEqual([skillDir])
        })
    })

    test("existing skill with no frontmatter description returns retry error", async () => {
        await withTempDir(async (root) => {
            const skillDir = join(root, ".agents", "skills", "learned-corrections", "learned-correction-no-desc")
            mkdirSync(skillDir, { recursive: true })
            writeFileSync(join(skillDir, "SKILL.md"), [
                "---",
                "name: learned-correction-no-desc",
                "---",
                "",
                "- Body without description.",
                "",
            ].join("\n"))

            const result = await executeCorrectionTool(root, {
                name: "No desc",
                content: "- Updated body.",
            })

            expect(result).toMatchObject({
                failedAction: "learn skill",
                error: "Existing skill has no description in frontmatter.",
                instruction: "Retry with a trigger description on one line that describes when to use this skill.",
            })
        })
    })

    test("body includes Content outdated instruction line and dash separator", async () => {
        await withTempDir(async (root) => {
            await executeCorrectionTool(root, {
                name: "Separator test",
                content: "- Body line.",
                description: DEFAULT_DESCRIPTION,
            })

            const skillDir = "learned-correction-separator-test"
            const filePath = learnedSkillFile(root, "corrections", skillDir)
            const content = readFileSync(filePath, "utf8")

            expect(content).toContain("\n---\n")
            expect(content).toContain(`Content outdated? Call \`skill_learn\` with name=\`${skillDir}\` to correct.`)
        })
    })

    test("references creates reference files and a References section", async () => {
        await withTempDir(async (root) => {
            await executeCorrectionTool(root, {
                name: "Ref test",
                content: "- Body line.",
                description: DEFAULT_DESCRIPTION,
                references: [
                    { description: "Template file", path: "templates/foo.txt", content: "hello" },
                ],
            })

            const skillDir = "learned-correction-ref-test"
            const filePath = learnedSkillFile(root, "corrections", skillDir)
            const content = readFileSync(filePath, "utf8")
            const refPath = join(learnedSkillDir(root, "corrections"), skillDir, "templates", "foo.txt")

            expect(readFileSync(refPath, "utf8")).toBe("hello")
            expect(content).toContain("## References")
            expect(content).toContain("* [Template file](templates/foo.txt)")
        })
    })

    test("references with [delete] removes reference file and entry", async () => {
        await withTempDir(async (root) => {
            const skillDir = "learned-correction-ref-del-test"
            await executeCorrectionTool(root, {
                name: "Ref del test",
                content: "- Body line.",
                description: DEFAULT_DESCRIPTION,
                references: [
                    { description: "Template file", path: "templates/foo.txt", content: "hello" },
                ],
            })

            await executeCorrectionTool(root, {
                name: "Ref del test",
                content: "- Body line.",
                references: [
                    { description: "Template file", path: "templates/foo.txt", content: "[delete]" },
                ],
            })

            const filePath = learnedSkillFile(root, "corrections", skillDir)
            const content = readFileSync(filePath, "utf8")
            const refPath = join(learnedSkillDir(root, "corrections"), skillDir, "templates", "foo.txt")

            expect(existsSync(refPath)).toBe(false)
            expect(content).not.toContain("## References")
        })
    })
})
