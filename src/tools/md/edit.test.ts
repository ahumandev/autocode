import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createAutocodeMdEditTool } from "./edit"
import { createToolContext } from "../test_context"

describe("autocode_md_edit", () => {
    let dir: string
    let oldCwd: string
    const tool = createAutocodeMdEditTool()
    beforeEach(() => {
        oldCwd = process.cwd()
        dir = mkdtempSync(join(tmpdir(), "md-edit-"))
        process.chdir(dir)
    })
    afterEach(() => {
        process.chdir(oldCwd)
        rmSync(dir, { recursive: true, force: true })
    })

    const write = (name: string, lines: string[]): string => {
        const p = join(dir, name)
        writeFileSync(p, lines.join("\n"))
        return p
    }
    const replace = (p: string, args: Record<string, unknown>) =>
        tool.execute({ file_path: p, ...args } as never, createToolContext()).then((s) => JSON.parse(s as string))

    test("rename only changes heading text", async () => {
        const p = write("r1.md", ["# Old", "", "old text"])
        const r = await replace(p, { current_anchor: "Old", content: "old text", heading: "NewName" })
        const f = readFileSync(p, "utf8")
        expect(f).toContain("# NewName")
        expect(f).not.toContain("# Old")
        expect(r.outline.newname).toBeDefined()
    })

    test("move only relocates section under a new parent", async () => {
        const p = write("r2.md", ["# P", "", "p text", "", "# Q", "", "q text"])
        const r = await replace(p, { current_anchor: "Q", content: "q text", parent_anchor: "P" })
        const f = readFileSync(p, "utf8")
        expect(f).toContain("## Q")
        expect(r.outline.p.q).toBeDefined()
    })

    test("rewrite only replaces own-text; sub-section content preserved", async () => {
        const p = write("r3.md", ["# P", "", "old p", "", "## C", "", "c text"])
        await replace(p, { current_anchor: "P", content: "new p body" })
        const f = readFileSync(p, "utf8")
        expect(f).toContain("new p body")
        expect(f).toContain("## C")
        expect(f).toContain("c text")
        expect(f).not.toContain("old p")
    })

    test("rename + move + rewrite combined", async () => {
        const p = write("r4.md", ["# P", "", "p text", "", "# Old", "", "old body"])
        const r = await replace(p, { current_anchor: "Old", content: "new body", heading: "New", parent_anchor: "P" })
        const f = readFileSync(p, "utf8")
        expect(f).toContain("## New")
        expect(f).toContain("new body")
        expect(f).not.toContain("# Old")
        expect(f).not.toContain("old body")
        expect(r.outline.p.new).toBeDefined()
    })

    test("heading level auto-adjusts on cross-depth move", async () => {
        const p = write("r5.md", ["# A", "", "a text", "", "### C", "", "c text", "", "## B", "", "b text"])
        await replace(p, { current_anchor: "B", content: "b text", parent_anchor: "C" })
        const f = readFileSync(p, "utf8")
        // line-anchored: "#### B" must not be mistaken for "## B" (substring pitfall)
        expect(f).toMatch(/^#### B$/m)
        expect(f).not.toMatch(/^## B$/m)
    })

    test("cycle error when new_parent is a descendant of current_anchor", async () => {
        const p = write("r6.md", ["# A", "", "a text", "", "## B", "", "b text"])
        const before = readFileSync(p, "utf8")
        const r = await replace(p, { current_anchor: "A", parent_anchor: "B" })
        expect(r.failedAction).toBe("autocode_md_edit")
        expect(r.instruction).toContain("cycle")
        expect(readFileSync(p, "utf8")).toBe(before)
    })

    test("parent-not-found error", async () => {
        const p = write("r7.md", ["# A", "", "a text"])
        const r = await replace(p, { current_anchor: "A", parent_anchor: "Ghost" })
        expect(r.failedAction).toBe("autocode_md_edit")
        expect(r.instruction).toContain("not found")
        expect(r.instruction).toContain("Ghost")
    })

    test("self-parent error when parent_anchor === current_anchor", async () => {
        const p = write("r9.md", ["# A", "", "a text"])
        const r = await replace(p, { current_anchor: "A", parent_anchor: "A" })
        expect(r.failedAction).toBe("autocode_md_edit")
        expect(r.instruction).toContain("under itself")
    })

    test("index=0 moves sibling to first position", async () => {
        const p = write("r10a.md", ["# R", "", "r text", "", "## B", "", "b text", "", "## C", "", "c text"])
        const r = await replace(p, { current_anchor: "C", index: 0 })
        const kids = Object.keys(r.outline.r).filter((k) => k !== "_lines")
        expect(kids).toEqual(["c", "b"])
    })

    test("index=-1 moves sibling to last position", async () => {
        const p = write("r10b.md", ["# R", "", "r text", "", "## B", "", "b text", "", "## C", "", "c text"])
        const r = await replace(p, { current_anchor: "B", index: -1 })
        const kids = Object.keys(r.outline.r).filter((k) => k !== "_lines")
        expect(kids).toEqual(["c", "b"])
    })

    test("index=N inserts at the Nth position", async () => {
        const p = write("r10c.md", ["# R", "", "r text", "", "## B", "", "b text", "", "## C", "", "c text", "", "## D", "", "d text"])
        const r = await replace(p, { current_anchor: "B", index: 1 })
        const kids = Object.keys(r.outline.r).filter((k) => k !== "_lines")
        expect(kids).toEqual(["c", "b", "d"])
    })

    test("atomicity: file is unchanged when parent-not-found error is returned", async () => {
        const p = write("r11.md", ["# A", "", "a text", "", "## B", "", "b text"])
        const before = readFileSync(p, "utf8")
        const r = await replace(p, { current_anchor: "A", parent_anchor: "Ghost" })
        expect(r.failedAction).toBe("autocode_md_edit")
        expect(readFileSync(p, "utf8")).toBe(before)
    })

    test("omit current_anchor with heading creates a new root section", async () => {
        const p = write("r12.md", ["# Top", "", "top text", "", "## One", "", "one text", "", "## Two", "", "two text"])
        const r = await replace(p, { heading: "Added" })
        const f = readFileSync(p, "utf8")
        expect(f).toContain("# Added")
        expect(r.outline.added).toBeDefined()
    })

    test("omit current_anchor without heading returns error and leaves file unchanged", async () => {
        const p = write("r13.md", ["# Top", "", "top text"])
        const before = readFileSync(p, "utf8")
        const r = await replace(p, { content: "x" })
        expect(r.failedAction).toBe("autocode_md_edit")
        expect(readFileSync(p, "utf8")).toBe(before)
    })

    test("current_anchor=[root] replaces file preamble and preserves headings body", async () => {
        const p = write("r14.md", ["old preamble", "", "# Top", "", "top text", "", "## One", "", "one text"])
        await replace(p, { current_anchor: "[root]", content: "new preamble" })
        const f = readFileSync(p, "utf8")
        expect(f).toContain("new preamble")
        expect(f).not.toContain("old preamble")
        expect(f).toContain("# Top")
        expect(f).toContain("top text")
        expect(f).toContain("## One")
        expect(f).toContain("one text")
    })

    test("current_anchor=[root] with empty content removes preamble but preserves headings", async () => {
        const p = write("r15.md", ["old preamble", "", "# Top", "", "top text", "", "## One", "", "one text"])
        await replace(p, { current_anchor: "[root]", content: "" })
        const f = readFileSync(p, "utf8")
        expect(f).not.toContain("old preamble")
        expect(f).toContain("# Top")
        expect(f).toContain("top text")
        expect(f).toContain("## One")
        expect(f).toContain("one text")
    })

    test("current_anchor=[root] with content key omitted removes preamble and preserves headings", async () => {
        const p = write("top-omit.md", ["old preamble line", "", "# Heading", "", "heading body"])
        const r = await replace(p, { current_anchor: "[root]" })
        expect(r.failedAction).toBeUndefined()
        const f = readFileSync(p, "utf8")
        expect(f).not.toContain("old preamble line")
        expect(f).toMatch(/^# Heading$/m)
        expect(f).toContain("heading body")
    })

    test("parent_anchor=[root] moves section to root H1 level", async () => {
        const p = write("r16.md", ["# Top", "", "top text", "", "## One", "", "one text", "", "## Nested", "", "nested text"])
        await replace(p, { current_anchor: "nested", parent_anchor: "[root]" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^# Nested$/m)
        expect(f).not.toMatch(/^## Nested$/m)
    })

    test("parent_anchor=\"\" moves section to root H1 level", async () => {
        const p = write("r17.md", ["# Top", "", "top text", "", "## One", "", "one text", "", "## Nested", "", "nested text"])
        await replace(p, { current_anchor: "nested", parent_anchor: "" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^# Nested$/m)
        expect(f).not.toMatch(/^## Nested$/m)
    })

    test("creates a new file when file_path does not exist", async () => {
        const p = join(dir, "nonexistent.md")
        const r = await replace(p, { heading: "Created", content: "fresh body text" })
        const f = readFileSync(p, "utf8")
        expect(f).toContain("# Created")
        expect(f).toContain("fresh body text")
        expect(r).toHaveProperty("file_path", p)
        expect(r.outline.created).toBeDefined()
    })
})
