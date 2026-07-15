import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { resetRetryCounts } from "@/utils/tools"
import { createAutocodeMdFrontmatterEditTool } from "./autocode_md_frontmatter_edit"
import { createToolContext } from "./test_context"
import type { ToolContext } from "@opencode-ai/plugin"

type FrontmatterEditTool = ReturnType<typeof createAutocodeMdFrontmatterEditTool>

let oldCwd: string | undefined
let tempDir: string = ""

function useTempCwd(): string {
    tempDir = mkdtempSync(join(tmpdir(), "autocode-fm-edit-"))
    oldCwd = process.cwd()
    process.chdir(tempDir)
    return tempDir
}

function parseResult(result: unknown): Record<string, any> {
    const text = typeof result === "string" ? result : (result as { output: string }).output
    return JSON.parse(text)
}

async function execute(
    tool: FrontmatterEditTool,
    args: { path: string; frontmatter: unknown },
    context: ToolContext = createToolContext({ directory: tempDir }),
) {
    return parseResult(await tool.execute(args as never, context))
}

afterEach(() => {
    resetRetryCounts()
    if (oldCwd) {
        process.chdir(oldCwd)
        oldCwd = undefined
    }
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true })
        tempDir = ""
    }
})

describe("createAutocodeMdFrontmatterEditTool", () => {
    test("updates frontmatter in markdown file already having frontmatter, preserves body", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "---\ntitle: Old\n---\n# Body\n\nOriginal body.\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, { path: "doc.md", frontmatter: "title: New\ndraft: true" })
        expect(result.path).toBe("doc.md")
        expect(result.hasFrontmatter).toBe(true)
        expect(result.changed).toBe(true)
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toContain("title: New")
        expect(disk).toContain("draft: true")
        expect(disk).toContain("Original body.")
        expect(disk).not.toContain("title: Old")
    })

    test("adds frontmatter to markdown file without frontmatter", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "# Body\n\nPlain body.\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, { path: "doc.md", frontmatter: "title: Inserted" })
        expect(result.hasFrontmatter).toBe(true)
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toContain("title: Inserted")
        expect(disk).toContain("Plain body.")
        expect(disk.startsWith("---")).toBe(true)
    })

    test("removes frontmatter when frontmatter arg is empty string", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "---\ntitle: Old\n---\n# Body\n\nKeep.\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, { path: "doc.md", frontmatter: "" })
        expect(result.hasFrontmatter).toBe(false)
        const disk = readFileSync(filePath, "utf8")
        expect(disk).not.toContain("title: Old")
        expect(disk).toContain("Keep.")
    })

    test("errors when frontmatter is not a string", async () => {
        const dir = useTempCwd()
        writeFileSync(join(dir, "doc.md"), "# Body\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, { path: "doc.md", frontmatter: 123 })
        expect(result.failedAction).toBe("write markdown frontmatter")
        expect(result.error).toContain("string")
    })

    test("errors on non-existent path", async () => {
        useTempCwd()
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, { path: "missing.md", frontmatter: "title: X" })
        expect(result.failedAction).toBe("write markdown frontmatter")
        expect(result.error).toContain("not found")
    })

    test("errors when editing frontmatter to JSON file", async () => {
        const dir = useTempCwd()
        writeFileSync(join(dir, "data.json"), "{}")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, { path: "data.json", frontmatter: "title: X" })
        expect(result.failedAction).toBe("write markdown frontmatter")
        expect(result.error).toContain("JSON")
    })

    test("replaces frontmatter when frontmatter arg is an object", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "---\ntitle: Old\n---\n# Body\n\nKeep.\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, { path: "doc.md", frontmatter: { title: "Foo", draft: true } })
        expect(result.path).toBe("doc.md")
        expect(result.hasFrontmatter).toBe(true)
        expect(result.changed).toBe(true)
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toContain("title: Foo")
        expect(disk).toContain("draft: true")
        expect(disk).toContain("Keep.")
        expect(disk).not.toContain("title: Old")
        expect(disk.startsWith("---")).toBe(true)
    })

    test("removes frontmatter when frontmatter arg is empty object", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "---\ntitle: Old\n---\n# Body\n\nKeep.\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, { path: "doc.md", frontmatter: {} })
        expect(result.hasFrontmatter).toBe(false)
        const disk = readFileSync(filePath, "utf8")
        expect(disk).not.toContain("title: Old")
        expect(disk).not.toContain("---")
        expect(disk).toContain("Keep.")
    })

    test("rejects array frontmatter with retry", async () => {
        const dir = useTempCwd()
        writeFileSync(join(dir, "doc.md"), "# Body\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, { path: "doc.md", frontmatter: ["a", "b"] })
        expect(result.failedAction).toBe("write markdown frontmatter")
        expect(result.error).toContain("string or object")
    })

    test("serializes nested object as YAML", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "# Body\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, {
            path: "doc.md",
            frontmatter: { meta: { author: "Alice", level: 3 } },
        })
        expect(result.hasFrontmatter).toBe(true)
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toContain("meta:")
        expect(disk).toContain("author: Alice")
        expect(disk).toContain("level: 3")
    })

    test("serializes object with array values", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "# Body\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, {
            path: "doc.md",
            frontmatter: { tags: ["a", "b"] },
        })
        expect(result.hasFrontmatter).toBe(true)
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toContain("tags:")
        expect(disk).toContain("- a")
        expect(disk).toContain("- b")
    })

    test("serializes object with null value", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "# Body\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, {
            path: "doc.md",
            frontmatter: { title: null },
        })
        expect(result.hasFrontmatter).toBe(true)
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toContain("title: null")
    })

    test("serializes object with boolean and number", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "# Body\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, {
            path: "doc.md",
            frontmatter: { draft: true, count: 5 },
        })
        expect(result.hasFrontmatter).toBe(true)
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toContain("draft: true")
        expect(disk).toContain("count: 5")
    })

    test("serializes object with multiline string", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "# Body\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, {
            path: "doc.md",
            frontmatter: { desc: "line1\nline2" },
        })
        expect(result.hasFrontmatter).toBe(true)
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toContain("desc:")
        expect(disk).toContain("line1")
        expect(disk).toContain("line2")
    })

    test("object replaces existing frontmatter and preserves body", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "---\nold: x\n---\nHello\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, {
            path: "doc.md",
            frontmatter: { new: "y" },
        })
        expect(result.hasFrontmatter).toBe(true)
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toContain("new: y")
        expect(disk).not.toContain("old: x")
        expect(disk).toContain("Hello")
    })

    test("object with empty string value keeps key", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "# Body\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        const result = await execute(tool, {
            path: "doc.md",
            frontmatter: { title: "" },
        })
        expect(result.hasFrontmatter).toBe(true)
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toMatch(/title: ''|title: ""/)
    })

    test("writes exactly 1 blank line between frontmatter and body when adding frontmatter", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "# Body\n\nPlain body.\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        await execute(tool, { path: "doc.md", frontmatter: "title: Inserted" })
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toMatch(/---\n\n# Body/)
        expect(disk).not.toMatch(/---\n# Body/)
        expect(disk).not.toMatch(/---\n\n\n# Body/)
    })

    test("preserves exactly 1 blank line between frontmatter and body when updating frontmatter", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "---\ntitle: Old\n---\n# Body\n\nOriginal body.\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        await execute(tool, { path: "doc.md", frontmatter: "title: New\ndraft: true" })
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toMatch(/---\n\n# Body/)
        expect(disk).not.toMatch(/---\n# Body/)
        expect(disk).not.toMatch(/---\n\n\n# Body/)
    })

    test("normalizes body leading newlines to exactly 1 blank line", async () => {
        const dir = useTempCwd()
        const filePath = join(dir, "doc.md")
        writeFileSync(filePath, "---\ntitle: X\n---\n\n\n# Body\n\nKeep.\n")
        const tool = createAutocodeMdFrontmatterEditTool()
        await execute(tool, { path: "doc.md", frontmatter: "title: Y" })
        const disk = readFileSync(filePath, "utf8")
        expect(disk).toMatch(/---\n\n# Body/)
        expect(disk).not.toMatch(/---\n# Body/)
        expect(disk).not.toMatch(/---\n\n\n# Body/)
    })
})
