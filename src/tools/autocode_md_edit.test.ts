import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { formatJobSessionTitle } from "@/utils/jobs"
import { createAutocodeMdEditTool } from "./autocode_md_edit"
import { createToolContext } from "./test_context"

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
        tool.execute({ file_path: p, ...args } as never, createToolContext({ directory: dir })).then((s) => JSON.parse(s as string))

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

    test("omit current_anchor with heading creates H2 child under last H1", async () => {
        const p = write("r12.md", ["# Top", "", "top text", "", "## One", "", "one text", "", "## Two", "", "two text"])
        const r = await replace(p, { heading: "Added" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^## Added$/m)
        expect(f).not.toMatch(/^# Added$/m)
        expect(r.outline.top).toBeDefined()
        expect(r.outline.top.added).toBeDefined()
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

    test("current_anchor=[root] with empty content preserves preamble", async () => {
        const p = write("r15.md", ["old preamble", "", "# Top", "", "top text", "", "## One", "", "one text"])
        await replace(p, { current_anchor: "[root]", content: "" })
        const f = readFileSync(p, "utf8")
        expect(f).toContain("old preamble")
        expect(f).toContain("# Top")
        expect(f).toContain("top text")
        expect(f).toContain("## One")
        expect(f).toContain("one text")
    })

    test("current_anchor=[root] with content omitted preserves preamble", async () => {
        const p = write("top-omit.md", ["old preamble line", "", "# Heading", "", "heading body"])
        const r = await replace(p, { current_anchor: "[root]" })
        expect(r.failedAction).toBeUndefined()
        const f = readFileSync(p, "utf8")
        expect(f).toContain("old preamble line")
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

    test("parent_anchor=\"\" keeps same parent (no move)", async () => {
        const p = write("r17.md", ["# Top", "", "top text", "", "## One", "", "one text", "", "## Nested", "", "nested text"])
        await replace(p, { current_anchor: "nested", parent_anchor: "" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^## Nested$/m)
        expect(f).not.toMatch(/^# Nested$/m)
    })

    test("creates a new file when file_path does not exist", async () => {
        const p = join(dir, "nonexistent.md")
        const r = await replace(p, { heading: "Created", content: "fresh body text" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^# Nonexistent$/m)
        expect(f).toMatch(/^## Created$/m)
        expect(f).toContain("fresh body text")
        expect(r).toHaveProperty("file_path", p)
        expect(r.outline.nonexistent).toBeDefined()
        expect(r.outline.nonexistent.created).toBeDefined()
    })

    test("create with no H1 in file creates placeholder H1 from filename and new section as H2 child", async () => {
        const p = write("blank-page.md", [""])
        const expectedTitle = formatJobSessionTitle("blank_page")
        const r = await replace(p, { heading: "Subsection", content: "body text" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(new RegExp(`^# ${expectedTitle.replace(/ /g, " ")}$`, "m"))
        expect(f).toMatch(/^## Subsection$/m)
        expect(f).toContain("body text")
        expect(r.outline["blank-page"]).toBeDefined()
        expect(r.outline["blank-page"].subsection).toBeDefined()
    })

    test("create defaults parent to last H1 when multiple H1s present", async () => {
        const p = write("multi-h1.md", [
            "# First",
            "",
            "first text",
            "",
            "# Second",
            "",
            "second text",
        ])
        const r = await replace(p, { heading: "New H2", content: "new text" })
        const f = readFileSync(p, "utf8")
        expect(f).toContain("# First")
        expect(f).toContain("first text")
        expect(f).toContain("# Second")
        expect(f).toContain("second text")
        expect(f).toMatch(/^## New H2$/m)
        expect(f).toContain("new text")
        const idxSecondBody = f.indexOf("second text")
        const idxNewH2 = f.indexOf("## New H2")
        expect(idxNewH2).toBeGreaterThan(idxSecondBody)
        expect(r.outline.second["new-h2"]).toBeDefined()
    })

    test("edit with parent_anchor=\"\" keeps same parent no move", async () => {
        const p = write("no-move.md", [
            "# Parent",
            "",
            "parent text",
            "",
            "## Nested",
            "",
            "nested text",
        ])
        const before = readFileSync(p, "utf8")
        const r = await replace(p, { current_anchor: "nested", parent_anchor: "" })
        expect(r.failedAction).toBeUndefined()
        const after = readFileSync(p, "utf8")
        expect(after).toBe(before)
    })

    test("index < -1 returns error and leaves file unchanged", async () => {
        const p = write("bad-index.md", ["# A", "", "a text"])
        const before = readFileSync(p, "utf8")
        const r = await replace(p, { current_anchor: "a", index: -2 })
        expect(r.failedAction).toBe("autocode_md_edit")
        expect(r.instruction).toContain("index")
        expect(readFileSync(p, "utf8")).toBe(before)
    })

    describe("blank-line rule (exactly 1 empty line at section boundaries)", () => {
        const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const assertBoundary = (content: string, left: string, right: string): void => {
            const l = escapeRe(left)
            const r = escapeRe(right)
            expect(content).toMatch(new RegExp(`${l}\\n\\n${r}`))
            expect(content).not.toMatch(new RegExp(`${l}\\n\\n\\n${r}`))
            expect(content).not.toMatch(new RegExp(`${l}\\n${r}`))
        }
        const assertNoTrailingBlank = (content: string): void => {
            expect(content).not.toMatch(/\n\n$/)
            expect(content).toMatch(/\n$/)
        }

        test("heading→content on CREATE (empty file, parent=[root])", async () => {
            const p = join(dir, "bl-h1-content.md")
            const r = await replace(p, { heading: "Title", content: "Body", parent_anchor: "[root]" })
            expect(r.failedAction).toBeUndefined()
            const f = readFileSync(p, "utf8")
            assertBoundary(f, "# Title", "Body")
            assertNoTrailingBlank(f)
        })

        test("content→next sibling heading on CREATE under existing parent", async () => {
            const p = write("bl-sibling.md", ["# Root", "", "Root body"])
            const r = await replace(p, { heading: "Sub", content: "Sub body", parent_anchor: "Root" })
            expect(r.failedAction).toBeUndefined()
            const f = readFileSync(p, "utf8")
            assertBoundary(f, "Root body", "## Sub")
            assertNoTrailingBlank(f)
        })

        test("content→next ancestor heading", async () => {
            const p = write("bl-ancestor.md", ["# A", "", "Abody", "", "## B", "", "Bbody"])
            const r = await replace(p, { heading: "C", content: "Cbody", parent_anchor: "[root]" })
            expect(r.failedAction).toBeUndefined()
            const f = readFileSync(p, "utf8")
            assertBoundary(f, "Bbody", "# C")
            assertNoTrailingBlank(f)
        })

        test("heading with no content → child heading", async () => {
            const p = join(dir, "bl-no-content.md")
            const r1 = await replace(p, { heading: "Parent", parent_anchor: "[root]" })
            expect(r1.failedAction).toBeUndefined()
            const r2 = await replace(p, { heading: "Child", content: "Child body", parent_anchor: "Parent" })
            expect(r2.failedAction).toBeUndefined()
            const f = readFileSync(p, "utf8")
            assertBoundary(f, "# Parent", "## Child")
            assertNoTrailingBlank(f)
        })

        test("root→next root heading (multiple H1s)", async () => {
            const p = write("bl-h1-h1.md", ["# First", "", "First body"])
            const r = await replace(p, { heading: "Second", content: "Second body", parent_anchor: "[root]" })
            expect(r.failedAction).toBeUndefined()
            const f = readFileSync(p, "utf8")
            assertBoundary(f, "First body", "# Second")
            assertNoTrailingBlank(f)
        })

        test("preamble→first heading via [root]", async () => {
            const p = write("bl-preamble.md", ["old preamble", "", "# Heading", "", "heading body"])
            const r = await replace(p, { current_anchor: "[root]", content: "Preamble text" })
            expect(r.failedAction).toBeUndefined()
            const f = readFileSync(p, "utf8")
            assertBoundary(f, "Preamble text", "# Heading")
            assertNoTrailingBlank(f)
        })

        test("frontmatter→body", async () => {
            const p = write("bl-frontmatter.md", ["---", "title: X", "---"])
            const r = await replace(p, { heading: "Title", content: "Body", parent_anchor: "[root]" })
            expect(r.failedAction).toBeUndefined()
            const f = readFileSync(p, "utf8")
            assertBoundary(f, "---", "# Title")
            assertNoTrailingBlank(f)
        })

        test("round-trip preservation: no-op edit leaves file unchanged with blank line preserved", async () => {
            const p = write("bl-roundtrip.md", ["# Title", "", "Body text", ""])
            const before = readFileSync(p, "utf8")
            const r = await replace(p, { current_anchor: "Title" })
            expect(r.failedAction).toBeUndefined()
            const after = readFileSync(p, "utf8")
            expect(after).toBe(before)
            assertBoundary(after, "# Title", "Body text")
            assertNoTrailingBlank(after)
        })

        test("no doubled blank lines after rewrite", async () => {
            const p = write("bl-no-double.md", ["# T", "", "B"])
            const r = await replace(p, { current_anchor: "T", content: "B" })
            expect(r.failedAction).toBeUndefined()
            const f = readFileSync(p, "utf8")
            expect(f).not.toMatch(/B\n\n\n/)
            assertBoundary(f, "# T", "B")
            assertNoTrailingBlank(f)
        })
    })
})
