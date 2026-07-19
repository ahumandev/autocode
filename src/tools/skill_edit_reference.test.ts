import { beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { createSkillEditReferenceTool } from "./skill_edit_reference"
import { createToolContext } from "./test_context"
import { resetRetryCounts } from "@/utils/tools"

type ToolResult = string | Record<string, unknown>

function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), "autocode-skill-edit-reference-"))

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

async function executeWrite(root: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = createSkillEditReferenceTool()
    const result = await tool.execute(args as never, createToolContext({
        directory: root,
        worktree: root,
    }))

    return parseToolResult(result)
}

function skillFile(root: string, skillName: string, link: string): string {
    return join(root, ".agents", "skills", skillName, link)
}

beforeEach(() => {
    resetRetryCounts()
})

describe("skill_edit_reference", () => {
    test("writes file at skill root", async () => {
        await withTempDir(async (root) => {
            const result = await executeWrite(root, {
                skill_name: "my-skill",
                skill_link: "template.xml",
                content: "hello world",
            })

            expect(result).toBe("OK")

            const filePath = skillFile(root, "my-skill", "template.xml")
            expect(existsSync(filePath)).toBe(true)
            expect(readFileSync(filePath, "utf8")).toBe("hello world")
        })
    })

    test("writes file in nested directory", async () => {
        await withTempDir(async (root) => {
            const result = await executeWrite(root, {
                skill_name: "example-skill",
                skill_link: "reference/template.xml",
                content: "<xml/>",
            })

            expect(result).toBe("OK")

            const filePath = skillFile(root, "example-skill", "reference/template.xml")
            expect(existsSync(filePath)).toBe(true)
            expect(readFileSync(filePath, "utf8")).toBe("<xml/>")
        })
    })

    test("creates deeply nested directories", async () => {
        await withTempDir(async (root) => {
            await executeWrite(root, {
                skill_name: "deep-skill",
                skill_link: "a/b/c/file.txt",
                content: "deep",
            })

            const filePath = skillFile(root, "deep-skill", "a/b/c/file.txt")
            expect(existsSync(filePath)).toBe(true)
            expect(readFileSync(filePath, "utf8")).toBe("deep")
        })
    })

    test("overwrites existing file", async () => {
        await withTempDir(async (root) => {
            await executeWrite(root, {
                skill_name: "ow-skill",
                skill_link: "data.txt",
                content: "first",
            })
            await executeWrite(root, {
                skill_name: "ow-skill",
                skill_link: "data.txt",
                content: "second",
            })

            const filePath = skillFile(root, "ow-skill", "data.txt")
            expect(readFileSync(filePath, "utf8")).toBe("second")
        })
    })

    test("rejects path traversal in skill_link", async () => {
        await withTempDir(async (root) => {
            const result = await executeWrite(root, {
                skill_name: "my-skill",
                skill_link: "../escape.txt",
                content: "bad",
            })

            expect(result).toMatchObject({ failedAction: "write skill file" })
            expect(existsSync(join(root, "escape.txt"))).toBe(false)
            expect(existsSync(join(root, ".agents", "skills", "my-skill", "escape.txt"))).toBe(false)
        })
    })

    test("rejects path traversal in skill_name", async () => {
        await withTempDir(async (root) => {
            const result = await executeWrite(root, {
                skill_name: "../../etc",
                skill_link: "file.txt",
                content: "bad",
            })

            expect(result).toMatchObject({ failedAction: "write skill file" })
        })
    })

    test("rejects absolute skill_link", async () => {
        await withTempDir(async (root) => {
            const result = await executeWrite(root, {
                skill_name: "my-skill",
                skill_link: "/etc/passwd",
                content: "bad",
            })

            expect(result).toMatchObject({ failedAction: "write skill file" })
            expect(existsSync("/etc/passwd.write-test")).toBe(false)
        })
    })

    test("rejects missing skill_name", async () => {
        await withTempDir(async (root) => {
            const result = await executeWrite(root, {
                skill_name: "  ",
                skill_link: "file.txt",
                content: "x",
            })

            expect(result).toMatchObject({ failedAction: "write skill file" })
            expect(String((result as Record<string, unknown>).error)).toContain("skill name")
        })
    })

    test("rejects missing skill_link", async () => {
        await withTempDir(async (root) => {
            const result = await executeWrite(root, {
                skill_name: "my-skill",
                skill_link: "",
                content: "x",
            })

            expect(result).toMatchObject({ failedAction: "write skill file" })
            expect(String((result as Record<string, unknown>).error)).toContain("skill link")
        })
    })

    test("preserves multiline and special-character content", async () => {
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

            await executeWrite(root, {
                skill_name: "rich-skill",
                skill_link: "content.md",
                content,
            })

            const filePath = skillFile(root, "rich-skill", "content.md")
            expect(readFileSync(filePath, "utf8")).toBe(content)
        })
    })

    test("writes empty content", async () => {
        await withTempDir(async (root) => {
            await executeWrite(root, {
                skill_name: "empty-skill",
                skill_link: "empty.txt",
                content: "",
            })

            const filePath = skillFile(root, "empty-skill", "empty.txt")
            expect(existsSync(filePath)).toBe(true)
            expect(readFileSync(filePath, "utf8")).toBe("")
        })
    })

    test("normalizes leading ./ in skill_link", async () => {
        await withTempDir(async (root) => {
            const result = await executeWrite(root, {
                skill_name: "norm-skill",
                skill_link: "./reference/template.xml",
                content: "<x/>",
            })

            expect(result).toBe("OK")
            expect(existsSync(skillFile(root, "norm-skill", "reference/template.xml"))).toBe(true)
        })
    })

    test("trims whitespace in skill_link", async () => {
        await withTempDir(async (root) => {
            await executeWrite(root, {
                skill_name: "trim-skill",
                skill_link: "  reference/template.xml  ",
                content: "x",
            })

            expect(existsSync(skillFile(root, "trim-skill", "reference/template.xml"))).toBe(true)
        })
    })

    test("rejects nested traversal in skill_link", async () => {
        await withTempDir(async (root) => {
            const result = await executeWrite(root, {
                skill_name: "my-skill",
                skill_link: "reference/../../escape.txt",
                content: "bad",
            })

            expect(result).toMatchObject({ failedAction: "write skill file" })
            expect(existsSync(join(root, ".agents", "skills", "escape.txt"))).toBe(false)
        })
    })

    test("allows writing the SKILL.md file itself", async () => {
        await withTempDir(async (root) => {
            const result = await executeWrite(root, {
                skill_name: "meta-skill",
                skill_link: "SKILL.md",
                content: "---\nname: meta-skill\ndescription: test\n---\n",
            })

            expect(result).toBe("OK")
            const filePath = skillFile(root, "meta-skill", "SKILL.md")
            expect(existsSync(filePath)).toBe(true)
            expect(readFileSync(filePath, "utf8")).toContain("name: meta-skill")
        })
    })
})
