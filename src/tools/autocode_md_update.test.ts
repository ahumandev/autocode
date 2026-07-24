import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetRetryCounts } from "@/utils/tools"
import { createAutocodeMdUpdateTool } from "./autocode_md_update"
import { createToolContext } from "./test_context"

describe("autocode_md_update", () => {
    let dir: string
    let oldCwd: string
    const tool = createAutocodeMdUpdateTool()
    beforeEach(() => {
        oldCwd = process.cwd()
        dir = mkdtempSync(join(tmpdir(), "md-update-"))
        process.chdir(dir)
    })
    afterEach(() => {
        process.chdir(oldCwd)
        rmSync(dir, { recursive: true, force: true })
        resetRetryCounts()
    })

    const write = (name: string, lines: string[]): string => {
        const p = join(dir, name)
        writeFileSync(p, lines.join("\n"))
        return p
    }
    const call = (p: string, args: Record<string, unknown>) =>
        tool.execute({ file_path: p, ...args } as never, createToolContext({ directory: dir })).then((s) => JSON.parse(s as string))

    test("rename H2 heading text updates on disk", async () => {
        const p = write("rename.md", ["# Article", "intro", "", "## Old Name", "body"])
        await call(p, { anchor: "old-name", heading: "New Name" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^## New Name$/m)
        expect(f).toContain("body")
        expect(f).not.toMatch(/^## Old Name$/m)
    })

    test("rewrite H2 body content preserves subsection structure", async () => {
        const p = write("rewrite.md", ["# Article", "intro", "", "## H2", "old text", "", "### H3", "h3body"])
        await call(p, { anchor: "h2", content: "new body" })
        const f = readFileSync(p, "utf8")
        expect(f).toContain("new body")
        expect(f).not.toContain("old text")
        expect(f).toMatch(/^### H3$/m)
        expect(f).toContain("h3body")
    })

    test("move section under different parent promotes level properly", async () => {
        const p = write("move.md", ["# Article", "", "## A", "a body", "", "## B", "b body"])
        await call(p, { anchor: "b", parent_anchor: "a" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^### B$/m)
        expect(f).toContain("b body")
        const idxA = f.indexOf("## A")
        const idxB = f.indexOf("### B")
        expect(idxA).toBeLessThan(idxB)
    })

    test("rejects [root] parent_anchor with autocode_md_h1 suggestion", async () => {
        const p = write("root-reject.md", ["# Top", "intro", "", "## MySubsection", "body"])
        const r = await call(p, { anchor: "mysubsection", parent_anchor: "[root]" })
        expect(r.failedAction).toBe("autocode_md_update")
        expect(r.instruction).toContain("autocode_md_h1")
    })

    test("anchor not found returns error advising autocode_md_read", async () => {
        const p = write("missing-anchor.md", ["# Top", "intro"])
        const r = await call(p, { anchor: "ghost", heading: "X" })
        expect(r.failedAction).toBe("autocode_md_update")
        expect(r.instruction).toContain("autocode_md_read")
        expect(r.instruction).toContain("ghost")
    })

    test("anchor ambiguous error mentions [n] postfix", async () => {
        const p = write("ambiguous.md", ["## Section A", "x", "", "## Section A", "y"])
        const r = await call(p, { anchor: "Section A", heading: "Renamed" })
        expect(r.failedAction).toBe("autocode_md_update")
        expect(r.instruction).toContain("[n]")
        expect(r.instruction).toContain("autocode_md_read")
    })

    test("self parent (parent_anchor equals anchor) returns retry error", async () => {
        const p = write("self-parent.md", ["# Top", "", "## A", "x", "", "## B", "y"])
        const r = await call(p, { anchor: "a", parent_anchor: "a" })
        expect(r.failedAction).toBe("autocode_md_update")
        expect(r.instruction).toContain("under itself")
    })

    test("cycle - parent_anchor is descendant of anchor returns retry error", async () => {
        const p = write("cycle.md", ["# Top", "", "## A", "", "### B", ""])
        const r = await call(p, { anchor: "a", parent_anchor: "b" })
        expect(r.failedAction).toBe("autocode_md_update")
        expect(r.instruction).toContain("cycle")
    })

    test("index=0 moves section to first sibling position", async () => {
        const p = write("move-0.md", ["# Article", "", "## A", "", "## B", "", "## C", ""])
        await call(p, { anchor: "c", index: 0 })
        const f = readFileSync(p, "utf8")
        const idxC = f.indexOf("## C")
        const idxA = f.indexOf("## A")
        expect(idxC).toBeGreaterThanOrEqual(0)
        expect(idxA).toBeGreaterThan(idxC)
    })

    test("index=-1 moves section to last sibling position", async () => {
        const p = write("move-neg1.md", ["# Article", "", "## A", "", "## B", "", "## C", ""])
        await call(p, { anchor: "a", index: -1 })
        const f = readFileSync(p, "utf8")
        const idxB = f.indexOf("## B")
        const idxC = f.indexOf("## C")
        const idxA = f.indexOf("## A")
        expect(idxB).toBeLessThan(idxC)
        expect(idxC).toBeLessThan(idxA)
    })

    test("index=N moves to Nth position", async () => {
        const p = write("move-n.md", ["# Article", "", "## A", "", "## B", "", "## C", ""])
        await call(p, { anchor: "a", index: 1 })
        const f = readFileSync(p, "utf8")
        const idxB = f.indexOf("## B")
        const idxA = f.indexOf("## A")
        const idxC = f.indexOf("## C")
        expect(idxB).toBeLessThan(idxA)
        expect(idxA).toBeLessThan(idxC)
    })

    test("no-op when all args omitted - file unchanged", async () => {
        const p = write("noop.md", ["# Article", "intro", "", "## Sub", "body"])
        const before = readFileSync(p, "utf8")
        await call(p, { anchor: "sub" })
        const after = readFileSync(p, "utf8")
        expect(after).toBe(before)
    })

    test("file not found returns error", async () => {
        const p = join(dir, "nonexistent.md")
        const r = await call(p, { anchor: "anything", heading: "X" })
        expect(r.failedAction).toBe("autocode_md_update")
    })

    test("parent_anchor not found error mentions autocode_md_read", async () => {
        const p = write("parent-ghost.md", ["# Top", "intro", "", "## Sub", "body"])
        const r = await call(p, { anchor: "sub", parent_anchor: "ghost" })
        expect(r.failedAction).toBe("autocode_md_update")
        expect(r.instruction).toContain("autocode_md_read")
        expect(r.instruction).toContain("ghost")
    })

    test("atomicity - on cycle error file unchanged", async () => {
        const p = write("atomicity-cycle.md", ["# Top", "", "## A", "", "### B", ""])
        const before = readFileSync(p, "utf8")
        await call(p, { anchor: "a", parent_anchor: "b" })
        const after = readFileSync(p, "utf8")
        expect(after).toBe(before)
    })

    test("rename H1 is allowed", async () => {
        const p = write("rename-h1.md", ["# Old Title", "intro", "", "## Sub", "body"])
        await call(p, { anchor: "old-title", heading: "New Title" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^# New Title$/m)
        expect(f).not.toMatch(/^# Old Title$/m)
        expect(f).toContain("intro")
        expect(f).toMatch(/^## Sub$/m)
    })

    test("invalid index (< -1) returns error", async () => {
        const p = write("bad-index.md", ["# A", "intro", "", "## Sub", "x"])
        const r = await call(p, { anchor: "sub", index: -2 })
        expect(r.failedAction).toBe("autocode_md_update")
        expect(r.instruction).toContain("index")
    })

    test("slug anchor directly resolves and supports rename", async () => {
        const p = write("slug-anchor.md", ["## My Section", "body"])
        await call(p, { anchor: "my-section", heading: "Renamed" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^## Renamed$/m)
        expect(f).toContain("body")
    })

    test("update content with subsections: appended after existing children, rebased to S.level+1", async () => {
        const p = write("update-subsec.md", [
            "# Article",
            "intro",
            "",
            "## Old Sub",
            "old body",
            "",
            "### Existing Inner",
            "inner body",
        ])
        await call(p, {
            anchor: "old-sub",
            content: "New body text\n\n## New Sub\n\nnew sub body",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxOld = lines.indexOf("## Old Sub")
        const idxNewBody = lines.indexOf("New body text")
        const idxExistingInner = lines.indexOf("### Existing Inner")
        const idxInnerBody = lines.indexOf("inner body")
        const idxNewSub = lines.indexOf("### New Sub")
        const idxNewSubBody = lines.indexOf("new sub body")
        expect(idxOld).toBeGreaterThanOrEqual(0)
        expect(idxNewBody).toBeGreaterThan(idxOld)
        expect(idxExistingInner).toBeGreaterThan(idxNewBody)
        expect(idxInnerBody).toBeGreaterThan(idxExistingInner)
        expect(idxNewSub).toBeGreaterThan(idxInnerBody)
        expect(idxNewSubBody).toBeGreaterThan(idxNewSub)
    })

    test("update content with deep subsection rebase (H4 in content under H2 section) down to H3", async () => {
        const p = write("update-deep.md", ["# Article", "", "## Section", "old body"])
        await call(p, {
            anchor: "section",
            content: "fresh body\n\n#### Inner H4\n\ninner",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxSection = lines.indexOf("## Section")
        const idxFresh = lines.indexOf("fresh body")
        const idxInnerH3 = lines.indexOf("### Inner H4")
        const idxInner = lines.indexOf("inner")
        expect(idxSection).toBeGreaterThanOrEqual(0)
        expect(idxFresh).toBeGreaterThan(idxSection)
        expect(idxInnerH3).toBeGreaterThan(idxFresh)
        expect(idxInner).toBeGreaterThan(idxInnerH3)
    })

    test("update content with no headings: flat body replacement preserves existing children", async () => {
        const p = write("update-flat.md", [
            "# Article",
            "intro",
            "",
            "## Old Sub",
            "old body",
            "",
            "### Existing Inner",
            "inner body",
        ])
        await call(p, { anchor: "old-sub", content: "just new text" })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxOld = lines.indexOf("## Old Sub")
        const idxJustNew = lines.indexOf("just new text")
        const idxExisting = lines.indexOf("### Existing Inner")
        const idxInnerBody = lines.indexOf("inner body")
        expect(idxOld).toBeGreaterThanOrEqual(0)
        expect(idxJustNew).toBeGreaterThan(idxOld)
        expect(idxExisting).toBeGreaterThan(idxJustNew)
        expect(idxInnerBody).toBeGreaterThan(idxExisting)
    })

    test("md_update on H1 section with content subsections rebases them to H2", async () => {
        const p = write("update-h1.md", ["# Existing H1", "old intro", "", "## Existing Sub", "sub body"])
        await call(p, {
            anchor: "existing-h1",
            content: "Fresh intro\n\n## New Sub A\n\nA body\n\n## New Sub B\n\nB body",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxH1 = lines.indexOf("# Existing H1")
        const idxFresh = lines.indexOf("Fresh intro")
        const idxExistingSub = lines.indexOf("## Existing Sub")
        const idxSubBody = lines.indexOf("sub body")
        const idxNewA = lines.indexOf("## New Sub A")
        const idxABody = lines.indexOf("A body")
        const idxNewB = lines.indexOf("## New Sub B")
        const idxBBody = lines.indexOf("B body")
        expect(idxH1).toBeGreaterThanOrEqual(0)
        expect(idxFresh).toBeGreaterThan(idxH1)
        expect(idxExistingSub).toBeGreaterThan(idxFresh)
        expect(idxSubBody).toBeGreaterThan(idxExistingSub)
        expect(idxNewA).toBeGreaterThan(idxSubBody)
        expect(idxABody).toBeGreaterThan(idxNewA)
        expect(idxNewB).toBeGreaterThan(idxABody)
        expect(idxBBody).toBeGreaterThan(idxNewB)
        expect(f).not.toContain("old intro")
    })
})
