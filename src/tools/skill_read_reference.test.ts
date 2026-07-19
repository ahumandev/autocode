import { beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { tmpdir } from "os"
import { createSkillReadReferenceTool } from "./skill_read_reference"
import { createToolContext } from "./test_context"
import { resetRetryCounts } from "@/utils/tools"

type ToolResult = string | Record<string, unknown>

function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), "autocode-skill-read-reference-"))

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

async function executeRead(root: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = createSkillReadReferenceTool()
    const result = await tool.execute(args as never, createToolContext({
        directory: root,
        worktree: root,
    }))

    return parseToolResult(result)
}

function skillFile(root: string, skillName: string, link: string): string {
    return join(root, ".agents", "skills", skillName, link)
}

function writeSkillFile(root: string, skillName: string, link: string, content: string): string {
    const filePath = skillFile(root, skillName, link)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content)
    return filePath
}

beforeEach(() => {
    resetRetryCounts()
})

describe("skill_read_reference", () => {
    test("reads file at skill root", async () => {
        await withTempDir(async (root) => {
            const filePath = writeSkillFile(root, "my-skill", "template.xml", "hello world")

            const result = await executeRead(root, {
                skill_name: "my-skill",
                skill_link: "template.xml",
            })

            expect(result).toBe("hello world")
            expect(existsSync(filePath)).toBe(true)
        })
    })

    test("reads file in nested directory", async () => {
        await withTempDir(async (root) => {
            writeSkillFile(root, "example-skill", "reference/template.xml", "<xml/>")

            const result = await executeRead(root, {
                skill_name: "example-skill",
                skill_link: "reference/template.xml",
            })

            expect(result).toBe("<xml/>")
        })
    })

    test("rejects path traversal in skill_link", async () => {
        await withTempDir(async (root) => {
            writeSkillFile(root, "my-skill", "template.xml", "ok")

            const result = await executeRead(root, {
                skill_name: "my-skill",
                skill_link: "../escape.txt",
            })

            expect(result).toMatchObject({ failedAction: "read skill file" })
        })
    })

    test("rejects path traversal in skill_name", async () => {
        await withTempDir(async (root) => {
            writeSkillFile(root, "my-skill", "template.xml", "ok")
            writeFileSync(join(root, "escape.txt"), "bad")

            const result = await executeRead(root, {
                skill_name: "../../etc",
                skill_link: "file.txt",
            })

            expect(result).toMatchObject({ failedAction: "read skill file" })
        })
    })

    test("rejects absolute skill_link", async () => {
        await withTempDir(async (root) => {
            const result = await executeRead(root, {
                skill_name: "my-skill",
                skill_link: "/etc/passwd",
            })

            expect(result).toMatchObject({ failedAction: "read skill file" })
        })
    })

    test("rejects missing skill_name", async () => {
        await withTempDir(async (root) => {
            const result = await executeRead(root, {
                skill_name: "  ",
                skill_link: "file.txt",
            })

            expect(result).toMatchObject({ failedAction: "read skill file" })
            expect(String((result as Record<string, unknown>).error)).toContain("skill name")
        })
    })

    test("rejects missing skill_link", async () => {
        await withTempDir(async (root) => {
            const result = await executeRead(root, {
                skill_name: "my-skill",
                skill_link: "",
            })

            expect(result).toMatchObject({ failedAction: "read skill file" })
            expect(String((result as Record<string, unknown>).error)).toContain("skill link")
        })
    })

    test("returns abort when file missing", async () => {
        await withTempDir(async (root) => {
            const result = await executeRead(root, {
                skill_name: "my-skill",
                skill_link: "missing.txt",
            })

            expect(result).toMatchObject({ failedAction: "read skill file" })
            expect(String((result as Record<string, unknown>).error)).toContain("File not found")
        })
    })

    test("reads multiline/special-char content", async () => {
        await withTempDir(async (root) => {
            const content = [
                "# Title",
                "",
                "Unicode: café — 日本語 ✓",
                'Quotes: "double" and \'single\'',
                "Backtick `code` and ${interp}",
                "<tag attr='val'>nested</tag>",
                "{ \"json\": true }",
            ].join("\n")

            writeSkillFile(root, "rich-skill", "content.md", content)

            const result = await executeRead(root, {
                skill_name: "rich-skill",
                skill_link: "content.md",
            })

            expect(result).toBe(content)
        })
    })

    test("normalizes leading ./ in skill_link", async () => {
        await withTempDir(async (root) => {
            writeSkillFile(root, "norm-skill", "reference/template.xml", "<x/>")

            const result = await executeRead(root, {
                skill_name: "norm-skill",
                skill_link: "./reference/template.xml",
            })

            expect(result).toBe("<x/>")
        })
    })

    test("trims whitespace in skill_link", async () => {
        await withTempDir(async (root) => {
            writeSkillFile(root, "trim-skill", "reference/template.xml", "x")

            const result = await executeRead(root, {
                skill_name: "trim-skill",
                skill_link: "  reference/template.xml  ",
            })

            expect(result).toBe("x")
        })
    })
})
