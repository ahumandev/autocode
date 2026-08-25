import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAutocodeMdDocxTool } from "./autocode_markdown_docx"
import { createToolContext } from "./test_context"

const MARKDOWN = [
    "# Guide",
    "",
    "- First item",
    "- [x] Completed task",
    "",
    "[Autocode](https://example.com)",
    "",
    "```ts",
    "const value = 1",
    "```",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| DOCX | Ready |",
].join("\n")

describe("autocode_markdown_docx", () => {
    let dir: string
    let oldCwd: string
    const tool = createAutocodeMdDocxTool()

    beforeEach(() => {
        oldCwd = process.cwd()
        dir = mkdtempSync(join(tmpdir(), "markdown-docx-"))
        process.chdir(dir)
    })

    afterEach(() => {
        process.chdir(oldCwd)
        rmSync(dir, { recursive: true, force: true })
    })

    const call = (filePath: string) => tool.execute(
        { file_path: filePath } as never,
        createToolContext({ directory: dir }),
    ).then((result) => JSON.parse(result as string))

    test("converts rich Markdown to a sibling DOCX", async () => {
        const sourcePath = join(dir, "guide.md")
        const outputPath = join(dir, "guide.docx")
        writeFileSync(sourcePath, MARKDOWN)

        const result = await call("guide.md")
        const bytes = readFileSync(outputPath)

        expect(existsSync(outputPath)).toBe(true)
        expect(bytes.byteLength).toBeGreaterThan(0)
        expect([...bytes.subarray(0, 2)]).toEqual([0x50, 0x4b])
        expect(result).toEqual({
            output_path: outputPath,
        })
    })

    test("replaces an existing sibling DOCX", async () => {
        const sourcePath = join(dir, "guide.md")
        const outputPath = join(dir, "guide.docx")
        writeFileSync(sourcePath, MARKDOWN)
        writeFileSync(outputPath, Uint8Array.from([0, 1, 2, 3]))
        const oldBytes = readFileSync(outputPath)

        const result = await call("guide.md")
        const bytes = readFileSync(outputPath)

        expect(bytes.equals(oldBytes)).toBe(false)
        expect([...bytes.subarray(0, 2)]).toEqual([0x50, 0x4b])
    })

    test("returns failed action for a missing Markdown file", async () => {
        const result = await call("missing.md")

        expect(result.failedAction).toBe("autocode_markdown_docx")
    })

    test("returns failed action for an existing non-Markdown file", async () => {
        writeFileSync(join(dir, "notes.txt"), "Not Markdown")

        const result = await call("notes.txt")

        expect(result.failedAction).toBe("autocode_markdown_docx")
    })
})
