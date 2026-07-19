import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { resetRetryCounts } from "@/utils/tools"
import { createAutocodeMdReadTool } from "./autocode_md_read"
import { createToolContext } from "./test_context"

describe("autocode_md_read", () => {
    let dir: string
    let oldCwd: string
    const tool = createAutocodeMdReadTool()
    beforeEach(() => {
        oldCwd = process.cwd()
        dir = mkdtempSync(join(tmpdir(), "md-read-"))
        process.chdir(dir)
    })
    afterEach(() => {
        process.chdir(oldCwd)
        rmSync(dir, { recursive: true, force: true })
        resetRetryCounts()
    })

    const write = (name: string, lines: string | string[]): string => {
        const p = join(dir, name)
        const body = Array.isArray(lines) ? lines.join("\n") : lines
        writeFileSync(p, body)
        return p
    }
    const read = (glob: string, args: Record<string, unknown> = {}) =>
        tool.execute({ file_path_glob: glob, ...args } as never, createToolContext({ directory: dir })).then((s) => JSON.parse(s as string))

    test("glob *.md returns file_paths with heading/anchor/line entries; counts correct (multiple -> outline only)", async () => {
        write("doc.md", [
            "# A", "", "intro", "", "## A1", "", "a1 text", "", "## A2", "", "a2 text",
        ])
        const out = await read("doc.md")
        expect(Object.keys(out.file_paths)).toEqual(["doc.md"])
        const entry = out.file_paths["doc.md"]
        expect(Array.isArray(entry)).toBe(true)
        expect(entry.length).toBe(3)
        const byAnchor: Record<string, { line_of_heading: number; line_count: number }> = {}
        for (const e of entry) {
            expect(e.anchor).toBeDefined()
            expect(typeof e.line_of_heading).toBe("number")
            expect(typeof e.line_count).toBe("number")
            expect((e as Record<string, unknown>).content).toBeUndefined()
            byAnchor[e.anchor] = { line_of_heading: e.line_of_heading, line_count: e.line_count }
        }
        expect(Object.keys(byAnchor).sort()).toEqual(["a", "a1", "a2"])
        expect(byAnchor["a"].line_of_heading).toBe(1)
        expect(byAnchor["a"].line_count).toBe(4)
        expect(byAnchor["a1"].line_of_heading).toBe(5)
        expect(byAnchor["a1"].line_count).toBe(7)
        expect(byAnchor["a2"].line_of_heading).toBe(9)
        expect(byAnchor["a2"].line_count).toBe(3)
        expect((entry[0] as Record<string, unknown>).nodes_shown).toBeUndefined()
        expect((entry[0] as Record<string, unknown>).nodes_total).toBeUndefined()
    })

    test("anchor_regex filter returns only matching section (single match -> content returned)", async () => {
        write("a.md", [
            "# A", "", "intro", "", "## A1", "", "a1 text", "", "## A2", "", "a2 text",
        ])
        const out = await read("a.md", { anchor_regex: "^a1$", max_content_chars: 700 })
        const entry = out.file_paths["a.md"]
        expect(entry.length).toBe(1)
        const e = entry[0]
        expect(e.anchor).toBe("a1")
        expect(e.line_of_heading).toBe(5)
        expect(e.line_count).toBe(7)
        expect(e.content).toBe("a1 text")
    })

    test("anchor_regex omitted returns all sections (multiple -> no content)", async () => {
        write("b.md", ["# A", "", "a", "", "## B", "", "b"])
        const out = await read("b.md")
        const entry = out.file_paths["b.md"]
        expect(entry.length).toBe(2)
        const byAnchor: Record<string, { line_of_heading: number; line_count: number }> = {}
        for (const e of entry) {
            expect(e.anchor).toBeDefined()
            expect(typeof e.line_of_heading).toBe("number")
            expect(typeof e.line_count).toBe("number")
            expect((e as Record<string, unknown>).content).toBeUndefined()
            byAnchor[e.anchor] = { line_of_heading: e.line_of_heading, line_count: e.line_count }
        }
        expect(Object.keys(byAnchor).sort()).toEqual(["a", "b"])
        expect(byAnchor["a"].line_of_heading).toBe(1)
        expect(byAnchor["a"].line_count).toBe(4)
        expect(byAnchor["b"].line_of_heading).toBe(5)
        expect(byAnchor["b"].line_count).toBe(3)
    })

    test("duplicate headers get GitHub-style -1,-2 suffix as anchor (multiple -> outline only)", async () => {
        write("dup.md", ["# Dup", "", "first", "", "# Dup", "", "second"])
        const out = await read("dup.md")
        const entry = out.file_paths["dup.md"]
        const anchors = entry.map((e: { anchor: string }) => e.anchor)
        expect(anchors).toEqual(["dup", "dup-1"])
        for (const e of entry) {
            expect((e as Record<string, unknown>).content).toBeUndefined()
        }
    })

    test("single match returns full content", async () => {
        write("tr.md", ["# H", "", "a1 text"])
        const out = await read("tr.md", { anchor_regex: "^h$", max_content_chars: 700 })
        const entry = out.file_paths["tr.md"]
        expect(entry.length).toBe(1)
        const e = entry[0]
        expect(e.content).toBe("a1 text")
    })

    test("non-match glob returns retry JSON error", async () => {
        const out = await read("nope/*.md")
        expect(out.failedAction).toBe("Read md section")
        expect(typeof out.error).toBe("string")
        expect(out.file_paths).toBeUndefined()
    })

    test("non-.md file is skipped (no .md -> retry error)", async () => {
        write("data.json", "{}")
        const out = await read("*.json")
        expect(out.file_paths).toBeUndefined()
        expect(out.failedAction).toBe("Read md section")
        expect(typeof out.error).toBe("string")
    })

    test("line_start > line_end returns retry error", async () => {
        write("doc.md", ["# A", "", "intro", "", "## A1", "", "a1 text", "", "## A2", "", "a2 text"])
        const out = await read("doc.md", { line_start: 10, line_end: 5 })
        expect(out.failedAction).toBe("Read md section")
        expect(out.file_paths).toBeUndefined()
    })

    test("line_start > total lines skips file (no sections -> retry error)", async () => {
        write("doc.md", ["# A", "", "intro", "", "## A1", "", "a1 text", "", "## A2", "", "a2 text"])
        const out = await read("doc.md", { line_start: 100, line_end: 200 })
        expect(out.failedAction).toBe("Read md section")
        expect(out.file_paths).toBeUndefined()
    })

    test("line_end > total lines clamps to last line (sections near end included)", async () => {
        write("doc.md", ["# A", "", "intro", "", "## A1", "", "a1 text", "", "## A2", "", "a2 text"])
        const out = await read("doc.md", { line_start: 9, line_end: 999 })
        const entry = out.file_paths["doc.md"]
        const anchors = entry.map((e: { anchor: string }) => e.anchor).sort()
        expect(anchors).toEqual(["a", "a2"])
    })

    test("sections entirely outside range are excluded (before and after)", async () => {
        write("doc.md", ["# A", "", "intro", "", "## A1", "", "a1 text", "", "## A2", "", "a2 text"])
        const out = await read("doc.md", { line_start: 5, line_end: 7 })
        const entry = out.file_paths["doc.md"]
        const anchors = entry.map((e: { anchor: string }) => e.anchor).sort()
        expect(anchors).toEqual(["a", "a1"])
    })

    test("line_start == line_end is valid (only overlapping sections included)", async () => {
        write("doc.md", ["# A", "", "intro", "", "## A1", "", "a1 text", "", "## A2", "", "a2 text"])
        const out = await read("doc.md", { line_start: 9, line_end: 9 })
        const entry = out.file_paths["doc.md"]
        const anchors = entry.map((e: { anchor: string }) => e.anchor).sort()
        expect(anchors).toEqual(["a", "a2"])
    })

    test("partial overlap returns full section content (not truncated)", async () => {
        write("doc.md", ["# A", "", "intro", "", "## A1", "", "a1 text", "", "## A2", "", "a2 text"])
        const out = await read("doc.md", { anchor_regex: "^a1$", line_start: 6, line_end: 7, max_content_chars: 700 })
        const entry = out.file_paths["doc.md"]
        expect(entry.length).toBe(1)
        const e = entry[0]
        expect(e.anchor).toBe("a1")
        expect(e.content).toBe("a1 text")
    })

    test("max_content_chars distributes budget evenly across all matching sections (2-pass water-filling)", async () => {
        write("cap.md", [
            "# A", "", "12345", "", "## B", "", "6789012345", "", "## C", "", "abcdef",
        ])
        const out = await read("cap.md", { max_content_chars: 12 })
        const entry = out.file_paths["cap.md"]
        expect(entry.length).toBe(3)
        const byAnchor: Record<string, string> = {}
        for (const e of entry) byAnchor[e.anchor] = e.content
        expect(byAnchor["a"]).toBe("1234")
        expect(byAnchor["b"]).toBe("6789")
        expect(byAnchor["c"]).toBe("abcd")
    })

    test("water-filling: small sections keep full content, leftover budget redistributed to larger section", async () => {
        write("wf.md", [
            "# A", "", "xy", "", "## B", "", "zw", "", "## C", "", "cccccccccccccccc",
        ])
        const out = await read("wf.md", { max_content_chars: 12 })
        const entry = out.file_paths["wf.md"]
        expect(entry.length).toBe(3)
        const byAnchor: Record<string, string> = {}
        for (const e of entry) byAnchor[e.anchor] = e.content
        expect(byAnchor["a"]).toBe("xy")
        expect(byAnchor["b"]).toBe("zw")
        expect(byAnchor["c"]).toBe("cccccccc")
        const total = entry.reduce((n: number, e: { content: string }) => n + e.content.length, 0)
        expect(total).toBe(12)
    })

    test("water-filling: all sections smaller than fair share keep full content (budget underused)", async () => {
        write("small.md", [
            "# A", "", "xy", "", "## B", "", "zw", "", "## C", "", "uv",
        ])
        const out = await read("small.md", { max_content_chars: 100 })
        const entry = out.file_paths["small.md"]
        expect(entry.length).toBe(3)
        const byAnchor: Record<string, string> = {}
        for (const e of entry) byAnchor[e.anchor] = e.content
        expect(byAnchor["a"]).toBe("xy")
        expect(byAnchor["b"]).toBe("zw")
        expect(byAnchor["c"]).toBe("uv")
    })

    test("water-filling: even split when every section exceeds fair share", async () => {
        write("even.md", [
            "# A", "", "aaaaa", "", "## B", "", "bbbbbbbbb", "", "## C", "", "cccccc",
        ])
        const out = await read("even.md", { max_content_chars: 12 })
        const entry = out.file_paths["even.md"]
        expect(entry.length).toBe(3)
        for (const e of entry) {
            expect(e.content.length).toBe(4)
        }
        const byAnchor: Record<string, string> = {}
        for (const e of entry) byAnchor[e.anchor] = e.content
        expect(byAnchor["a"]).toBe("aaaa")
        expect(byAnchor["b"]).toBe("bbbb")
        expect(byAnchor["c"]).toBe("cccc")
    })

    test("water-filling: budget below section count yields empty content for every section but all listed", async () => {
        write("edge.md", [
            "# A", "", "12345", "", "## B", "", "67890", "", "## C", "", "abcdef",
        ])
        const out = await read("edge.md", { max_content_chars: 2 })
        const entry = out.file_paths["edge.md"]
        expect(entry.length).toBe(3)
        for (const e of entry) {
            expect(e.content).toBe("")
        }
    })

    test("throws when context.directory is missing", async () => {
        const toolInstance = createAutocodeMdReadTool()
        await expect(
            toolInstance.execute({ file_path_glob: "*.md" } as never, createToolContext({ directory: "" })),
        ).rejects.toThrow(/autocode_md_read.*context\.directory/)
    })

    test("multi-file: file with line_start > its lineCount is skipped, others included", async () => {
        write("small.md", ["# S", "", "s"])
        write("big.md", ["# A", "", "intro", "", "## A1", "", "a1 text", "", "## A2", "", "a2 text"])
        const out = await read("*.md", { line_start: 5, line_end: 100 })
        expect(Object.keys(out.file_paths).sort()).toEqual(["big.md"])
    })
})
