import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
    createSkillLearnCorrectionTool,
    createSkillLearnEnvTool,
    createSkillLearnPermissionTool,
    createSkillLearnPreferenceTool,
    validateSkillLearnArgs,
} from "./skill_learn"
import { createToolContext } from "./test_context"

type ToolResult = string | Record<string, unknown>

const FIXED_TIME = new Date("2026-07-18T14:05:09")

const originalNow = Date.now

function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), "autocode-skill-learn-"))

    return fn(root).finally(() => {
        rmSync(root, { recursive: true, force: true })
    })
}

afterEach(() => {
    setSystemTime(new Date())
    ;(globalThis as { Date: typeof Date }).Date.now = originalNow as never
})

function parseToolResult(result: string | { output: string }): ToolResult {
    const output = typeof result === "string" ? result : result.output

    try {
        return JSON.parse(output) as Record<string, unknown>
    } catch {
        return output
    }
}

type SubjectName = "corrections" | "env" | "permissions" | "preferences"

function learnedSkillFile(root: string, subject: SubjectName, dirName: string): string {
    return join(root, ".agents", "skills", `learned-${subject}`, dirName, "SKILL.md")
}

function learnedSkillDir(root: string, subject: SubjectName): string {
    return join(root, ".agents", "skills", `learned-${subject}`)
}

function listLearnedDirs(root: string, subject: SubjectName): string[] {
    const dir = learnedSkillDir(root, subject)
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
}

function executeCorrectionTool(root: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = createSkillLearnCorrectionTool()
    return tool.execute(args as never, createToolContext({
        agent: "pair",
        directory: root,
        worktree: root,
    })).then((result) => parseToolResult(result as never))
}

function executeTool(
    factory: typeof createSkillLearnCorrectionTool,
    root: string,
    args: Record<string, unknown>,
    agent = "pair",
): Promise<ToolResult> {
    const tool = factory()
    return tool.execute(args as never, createToolContext({
        agent,
        directory: root,
        worktree: root,
    })).then((result) => parseToolResult(result as never))
}

const DEFAULT_DESCRIPTION = "Mistake was corrected by using bounded search."

describe("skill_learn tool validation", () => {
    test("rejects subject argument without creating files", async () => {
        await withTempDir(async (root) => {
            const result = await executeCorrectionTool(root, {
                subject: "other",
                title: "Title",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(result).toEqual({
                failedAction: "learn skill",
                error: "Unexpected argument(s): subject.",
                instruction: "Retry with title, content, and description arguments.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects ssh_key on non-env tool as unexpected argument", async () => {
        await withTempDir(async (root) => {
            const result = await executeCorrectionTool(root, {
                title: "Title",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
                ssh_key: "Prod-Key",
            })

            expect(result).toEqual({
                failedAction: "learn skill",
                error: "Unexpected argument(s): ssh_key.",
                instruction: "Retry with title, content, and description arguments.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects non-string ssh_key on env tool without creating files", async () => {
        await withTempDir(async (root) => {
            const result = await executeTool(createSkillLearnEnvTool, root, {
                title: "Title",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
                ssh_key: 123,
            })

            expect(result).toEqual({
                failedAction: "learn skill",
                error: "Invalid ssh_key. SSH key must be a string when provided.",
                instruction: "Retry with ssh_key omitted, blank, or using letters, numbers, underscores, or hyphens.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects unsafe ssh_key on env tool without creating files", async () => {
        await withTempDir(async (root) => {
            const result = await executeTool(createSkillLearnEnvTool, root, {
                title: "Title",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
                ssh_key: "../pair",
            })

            expect(result).toMatchObject({
                error: "Unsafe ssh_key: ../pair",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("validates title without creating files", async () => {
        await withTempDir(async (root) => {
            const emptyTitle = await executeCorrectionTool(root, {
                title: " ",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
            })
            const multilineTitle = await executeCorrectionTool(root, {
                title: "Bad\nTitle",
                content: "- Content.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(emptyTitle).toMatchObject({
                error: "Invalid title. Title must be non-empty and contain no newline or control characters.",
            })
            expect(multilineTitle).toMatchObject({
                error: "Invalid title. Title must be non-empty and contain no newline or control characters.",
            })
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects missing or invalid description without creating files", async () => {
        await withTempDir(async (root) => {
            const missingDescription = await executeCorrectionTool(root, {
                title: "Title",
                content: "- Content.",
            })
            const blankDescription = await executeCorrectionTool(root, {
                title: "Title",
                content: "- Content.",
                description: "   ",
            })
            const multilineDescription = await executeCorrectionTool(root, {
                title: "Title",
                content: "- Content.",
                description: "Bad\nDescription",
            })

            for (const result of [missingDescription, blankDescription, multilineDescription]) {
                expect(result).toMatchObject({
                    error: "Invalid description. Description must be non-empty and contain no newline or control characters.",
                    instruction: "Retry with a trigger description on one line that describes when to use this skill.",
                })
            }
            expect(existsSync(join(root, ".agents"))).toBe(false)
        })
    })

    test("rejects empty content without creating files", async () => {
        await withTempDir(async (root) => {
            const emptyContent = await executeCorrectionTool(root, {
                title: "Title",
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
                title: "Title",
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
            setSystemTime(FIXED_TIME)
            const result = await executeCorrectionTool(root, {
                title: "Avoid re-render",
                content: "- Wrap component in useMemo.",
                description: "Use this skill when a component re-renders unnecessarily.",
            })

            expect(result).toBe("OK")
            const expectedDir = "learned-corrections-26-07-18-14-05-09-avoid-re-render"
            const filePath = learnedSkillFile(root, "corrections", expectedDir)

            expect(existsSync(filePath)).toBe(true)
            expect(readFileSync(filePath, "utf8")).toBe([
                "---",
                `name: ${expectedDir}`,
                "description: Use this skill when a component re-renders unnecessarily.",
                "---",
                "",
                "## Avoid re-render",
                "",
                "- Wrap component in useMemo.",
                "",
                "----------",
                "",
            ].join("\n"))
            expect(listLearnedDirs(root, "corrections")).toEqual([expectedDir])
        })
    })

    test("env tool writes per-item dir with ssh_key segment in dir name", async () => {
        await withTempDir(async (root) => {
            setSystemTime(FIXED_TIME)
            const result = await executeTool(createSkillLearnEnvTool, root, {
                title: "Remote host A",
                content: "- Remote detail.",
                description: "Use this skill when SSH-ing into prod host A.",
                ssh_key: "Prod-Key",
            })

            expect(result).toBe("OK")
            const expectedDir = "learned-env-26-07-18-14-05-09-prod-key-remote-host-a"
            const filePath = learnedSkillFile(root, "env", expectedDir)

            expect(existsSync(filePath)).toBe(true)
            const content = readFileSync(filePath, "utf8")
            expect(content).toContain(`name: ${expectedDir}`)
            expect(content).toContain("## Remote host A")
            expect(listLearnedDirs(root, "env")).toEqual([expectedDir])
        })
    })

    test("env tool without ssh_key omits ssh segment from dir name", async () => {
        await withTempDir(async (root) => {
            setSystemTime(FIXED_TIME)
            const result = await executeTool(createSkillLearnEnvTool, root, {
                title: "Local dev",
                content: "- Local detail.",
                description: "Use this skill when local dev env limited.",
            })

            expect(result).toBe("OK")
            const expectedDir = "learned-env-26-07-18-14-05-09-local-dev"
            expect(existsSync(learnedSkillFile(root, "env", expectedDir))).toBe(true)
        })
    })

    test("truncates topic to 40 chars when title is long", async () => {
        await withTempDir(async (root) => {
            setSystemTime(FIXED_TIME)
            const longTopic = "a".repeat(60)
            const result = await executeCorrectionTool(root, {
                title: longTopic,
                content: "- Long content.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(result).toBe("OK")
            const truncated = "a".repeat(40)
            const expectedDir = `learned-corrections-26-07-18-14-05-09-${truncated}`

            expect(listLearnedDirs(root, "corrections")).toEqual([expectedDir])
            expect(existsSync(learnedSkillFile(root, "corrections", expectedDir))).toBe(true)
        })
    })

    test("falls back to untitled topic for non-alphanumeric title", async () => {
        await withTempDir(async (root) => {
            setSystemTime(FIXED_TIME)
            const result = await executeCorrectionTool(root, {
                title: "!!!",
                content: "- No usable chars.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(result).toBe("OK")
            const expectedDir = "learned-corrections-26-07-18-14-05-09-untitled"

            expect(listLearnedDirs(root, "corrections")).toEqual([expectedDir])
        })
    })

    test("suffixed -2 when same second same title is invoked twice", async () => {
        await withTempDir(async (root) => {
            setSystemTime(FIXED_TIME)
            const first = await executeCorrectionTool(root, {
                title: "Avoid re-render",
                content: "- First call.",
                description: DEFAULT_DESCRIPTION,
            })
            const second = await executeCorrectionTool(root, {
                title: "Avoid re-render",
                content: "- Second call.",
                description: DEFAULT_DESCRIPTION,
            })

            expect(first).toBe("OK")
            expect(second).toBe("OK")

            const baseDir = "learned-corrections-26-07-18-14-05-09-avoid-re-render"
            const suffixedDir = `${baseDir}-2`

            expect(listLearnedDirs(root, "corrections")).toEqual([baseDir, suffixedDir])
            expect(existsSync(learnedSkillFile(root, "corrections", baseDir))).toBe(true)
            expect(existsSync(learnedSkillFile(root, "corrections", suffixedDir))).toBe(true)
            expect(readFileSync(learnedSkillFile(root, "corrections", suffixedDir), "utf8")).toContain("name: learned-corrections-26-07-18-14-05-09-avoid-re-render-2")
        })
    })

    test("frontmatter description equals argument verbatim and name equals dir basename", async () => {
        await withTempDir(async (root) => {
            setSystemTime(FIXED_TIME)
            const description = "Trigger-focused when X then Y."
            await executeCorrectionTool(root, {
                title: "Trigger title",
                content: "- Lesson.",
                description,
            })

            const dirName = "learned-corrections-26-07-18-14-05-09-trigger-title"
            const content = readFileSync(learnedSkillFile(root, "corrections", dirName), "utf8")

            expect(content).toContain(`name: ${dirName}`)
            expect(content).toContain(`description: ${description}`)
        })
    })

    test("does not append or prune — each invocation writes a single isolated section", async () => {
        await withTempDir(async (root) => {
            setSystemTime(FIXED_TIME)
            await executeCorrectionTool(root, {
                title: "First",
                content: "- First.",
                description: DEFAULT_DESCRIPTION,
            })
            await executeCorrectionTool(root, {
                title: "Second",
                content: "- Second.",
                description: DEFAULT_DESCRIPTION,
            })

            const dirs = listLearnedDirs(root, "corrections")
            expect(dirs).toEqual([
                "learned-corrections-26-07-18-14-05-09-first",
                "learned-corrections-26-07-18-14-05-09-second",
            ])
            for (const dir of dirs) {
                const content = readFileSync(learnedSkillFile(root, "corrections", dir), "utf8")
                const sectionCount = (content.match(/^## /gm) ?? []).length
                expect(sectionCount).toBe(1)
                expect(content.endsWith("----------\n")).toBe(true)
            }
        })
    })

    test("permission tool writes per-item permission skill dir", async () => {
        await withTempDir(async (root) => {
            setSystemTime(FIXED_TIME)
            const result = await executeTool(createSkillLearnPermissionTool, root, {
                title: "Safe delete",
                content: "- Safe action.",
                description: "Use this skill when deleting files manually.",
            })

            expect(result).toBe("OK")
            expect(listLearnedDirs(root, "permissions")).toEqual([
                "learned-permissions-26-07-18-14-05-09-safe-delete",
            ])
        })
    })

    test("preference tool writes per-item preference skill dir", async () => {
        await withTempDir(async (root) => {
            setSystemTime(FIXED_TIME)
            const result = await executeTool(createSkillLearnPreferenceTool, root, {
                title: "Prefer tabs",
                content: "- Use tabs.",
                description: "Use this skill when a reviewer complains about indentation.",
            })

            expect(result).toBe("OK")
            expect(listLearnedDirs(root, "preferences")).toEqual([
                "learned-preferences-26-07-18-14-05-09-prefer-tabs",
            ])
        })
    })

    test("validateSkillLearnArgs trims title, content, and description", () => {
        const result = validateSkillLearnArgs({
            title: " Spaced Title ",
            content: "\n- Body.\n",
            description: " Trigger here ",
        })
        expect(result).toEqual({
            title: "Spaced Title",
            content: "- Body.",
            description: "Trigger here",
            sshKey: undefined,
        })
    })

    test("validateSkillLearnArgs normalizes ssh_key to lowercased trim", () => {
        const result = validateSkillLearnArgs({
            title: "Title",
            content: "- Body.",
            description: "Trigger.",
            ssh_key: "  Prod-Key  ",
        }, true)
        expect(result).toMatchObject({ sshKey: "prod-key" })
    })
})

describe("skill_learn old-format legacy dirs not touched", () => {
    test("legacy learned-corrections-pair skill dir at skills root remains after cleanup", async () => {
        await withTempDir(async (root) => {
            setSystemTime(FIXED_TIME)
            // Simulate legacy pre-rewrite shape: single skill dir at skills root.
            const legacyDir = join(root, ".agents", "skills", "learned-corrections-pair")
            mkdirSync(legacyDir, { recursive: true })
            writeFileSync(join(legacyDir, "SKILL.md"), "---\nname: legacy\n---\n# Legacy\n")
            await executeCorrectionTool(root, {
                title: "New lesson",
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