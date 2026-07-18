import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createAutocodeMdCreateTool } from "./autocode_md_create"
import { createToolContext } from "./test_context"

describe("autocode_md_create", () => {
    let dir: string
    let oldCwd: string
    const tool = createAutocodeMdCreateTool()
    beforeEach(() => {
        oldCwd = process.cwd()
        dir = mkdtempSync(join(tmpdir(), "md-create-"))
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
    const call = (p: string, args: Record<string, unknown> = {}) =>
        tool.execute({ file_path: p, ...args } as never, createToolContext({ directory: dir })).then((s) => JSON.parse(s as string))

    test("creates H2 under last H1 by default (blank parent)", async () => {
        const p = write("h1-default.md", ["# Article", "intro", "", "## Existing Sub", "body"])
        const r = await call(p, { heading: "New Section", content: "hello" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^# Article$/m)
        expect(f).toContain("intro")
        expect(f).toMatch(/^## Existing Sub$/m)
        expect(f).toMatch(/^## New Section$/m)
        const idxExisting = f.indexOf("## Existing Sub")
        const idxNew = f.indexOf("## New Section")
        expect(idxNew).toBeGreaterThan(idxExisting)
        expect(r.outline.article["new-section"]).toBeDefined()
    })

    test("creates H3 under specified H2 parent", async () => {
        const p = write("h3-parent.md", ["# Article", "intro", "", "## Existing Sub", "body"])
        const r = await call(p, { heading: "Nested", content: "x", parent_anchor: "existing-sub" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^### Nested$/m)
        expect(f).toContain("x")
        expect(r.outline.article["existing-sub"].nested).toBeDefined()
    })

    test("rejects [root] parent_anchor", async () => {
        const p = write("root-reject.md", ["# Article", "intro"])
        const r = await call(p, { heading: "X", parent_anchor: "[root]" })
        expect(r.failedAction).toBe("autocode_md_create")
        expect(r.instruction).toContain("[root]")
    })

    test("missing heading returns error", async () => {
        const p = write("missing-heading.md", ["# A", "intro"])
        const r = await call(p, {})
        expect(r.failedAction).toBe("autocode_md_create")
        expect(r.instruction).toContain("heading is required")
    })

    test("no H1 + blank parent - section becomes root H2 at end", async () => {
        const p = write("no-h1.md", ["## Sub1", "body1"])
        await call(p, { heading: "Added", content: "c" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^## Sub1$/m)
        expect(f).toContain("body1")
        expect(f).toMatch(/^## Added$/m)
        expect(f).toContain("c")
        const idxSub1 = f.indexOf("## Sub1")
        const idxAdded = f.indexOf("## Added")
        expect(idxAdded).toBeGreaterThan(idxSub1)
    })

    test("index=0 inserts as first sibling", async () => {
        const p = write("index0.md", ["# Article", "", "## A", "a", "", "## B", "b"])
        await call(p, { heading: "X", index: 0 })
        const f = readFileSync(p, "utf8")
        const idxX = f.indexOf("## X")
        const idxA = f.indexOf("## A")
        expect(idxX).toBeGreaterThanOrEqual(0)
        expect(idxA).toBeGreaterThan(idxX)
    })

    test("index=-1 inserts as last sibling", async () => {
        const p = write("index-neg1.md", ["# Article", "", "## A", "a", "", "## B", "b"])
        await call(p, { heading: "X", index: -1 })
        const f = readFileSync(p, "utf8")
        const idxB = f.indexOf("## B")
        const idxX = f.indexOf("## X")
        expect(idxX).toBeGreaterThan(idxB)
    })

    test("index=N inserts as Nth sibling (middle)", async () => {
        const p = write("index-n.md", ["# Article", "", "## A", "a", "", "## B", "b"])
        await call(p, { heading: "X", index: 1 })
        const f = readFileSync(p, "utf8")
        const idxA = f.indexOf("## A")
        const idxX = f.indexOf("## X")
        const idxB = f.indexOf("## B")
        expect(idxA).toBeLessThan(idxX)
        expect(idxX).toBeLessThan(idxB)
    })

    test("index < -1 returns invalid index error", async () => {
        const p = write("bad-index.md", ["# A", "intro"])
        const r = await call(p, { heading: "X", index: -2 })
        expect(r.failedAction).toBe("autocode_md_create")
        expect(r.instruction).toContain("index")
    })

    test("parent_anchor not found returns error mentioning autocode_md_read", async () => {
        const p = write("missing-parent.md", ["# A", "intro", "", "## Sub", "body"])
        const r = await call(p, { heading: "X", parent_anchor: "non-existent" })
        expect(r.failedAction).toBe("autocode_md_create")
        expect(r.instruction).toContain("autocode_md_read")
        expect(r.instruction).toContain("non-existent")
    })

    test("creates new file on missing file", async () => {
        const p = join(dir, "brand-new.md")
        expect(existsSync(p)).toBe(false)
        await call(p, { heading: "Created", content: "x" })
        expect(existsSync(p)).toBe(true)
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^## Created$/m)
        expect(f).toContain("x")
        expect(f).not.toMatch(/^# /m)
    })

    test("content omitted produces empty body section", async () => {
        const p = write("no-content.md", ["# Article", "intro", "", "## Existing", "body"])
        await call(p, { heading: "Stub" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^## Stub$/m)
        const stubIdx = f.indexOf("## Stub")
        const afterStub = f.slice(stubIdx + "## Stub".length)
        expect(afterStub.startsWith("\n")).toBe(true)
    })

    test("rejects invalid heading empty string", async () => {
        const p = write("empty-heading.md", ["# A", "intro"])
        const r = await call(p, { heading: "" })
        expect(r.failedAction).toBe("autocode_md_create")
        expect(r.instruction).toContain("heading is required")
    })

    test("atomicity - parent not found does not modify file", async () => {
        const p = write("atomicity.md", ["# A", "intro", "", "## Sub", "body"])
        const before = readFileSync(p, "utf8")
        await call(p, { heading: "X", parent_anchor: "ghost" })
        const after = readFileSync(p, "utf8")
        expect(after).toBe(before)
    })

    test("content with H1 subsection rebased to H3 under default H2 parent (no H1 in file)", async () => {
        const p = write("h1-rebase.md", ["## Existing", "body"])
        await call(p, {
            heading: "New Heading",
            content: "# Originally H1 heading\n\nSome text\n\n## Originally H2 heading\n\nSub-sub-section text",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxNew = lines.indexOf("## New Heading")
        const idxOrigH1 = lines.indexOf("### Originally H1 heading")
        const idxSome = lines.indexOf("Some text")
        const idxOrigH2 = lines.indexOf("#### Originally H2 heading")
        const idxSubSub = lines.indexOf("Sub-sub-section text")
        expect(idxNew).toBeGreaterThanOrEqual(0)
        expect(idxOrigH1).toBeGreaterThan(idxNew)
        expect(idxSome).toBeGreaterThan(idxOrigH1)
        expect(idxOrigH2).toBeGreaterThan(idxSome)
        expect(idxSubSub).toBeGreaterThan(idxOrigH2)
    })

    test("content with deeper H4/H5 subsection rebased down to H3/H4 under H2 parent", async () => {
        const p = write("deep-rebase.md", ["# H1", "intro"])
        await call(p, {
            heading: "New Section",
            content: "# Deep\n\nbody\n\n#### H4\n\nh4body\n\n##### H5\n\nh5body",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxDeep = lines.indexOf("### Deep")
        const idxH4 = lines.indexOf("###### H4")
        const idxH5 = lines.indexOf("###### H5")
        expect(idxDeep).toBeGreaterThanOrEqual(0)
        expect(idxH4).toBeGreaterThanOrEqual(0)
        expect(idxH5).toBeGreaterThanOrEqual(0)
        expect(idxDeep).toBeLessThan(idxH4)
        expect(idxH4).toBeLessThan(idxH5)
    })

    test("content with top-level H4 subsection rebased down to H3 under H2 parent (downward rebase)", async () => {
        const p = write("down-rebase.md", ["# Article", "intro"])
        await call(p, {
            heading: "Sub",
            content: "#### H4\n\nh4body\n\n##### H5\n\nh5body",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxH3 = lines.indexOf("### H4")
        const idxH4 = lines.indexOf("#### H5")
        expect(idxH3).toBeGreaterThanOrEqual(0)
        expect(idxH4).toBeGreaterThanOrEqual(0)
        expect(idxH3).toBeLessThan(idxH4)
    })

    test("content with no subsections (plain body) preserved as flat body", async () => {
        const p = write("plain-body.md", ["# Article", "intro"])
        await call(p, {
            heading: "Sub",
            content: "just plain text body, no headings here",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxSub = lines.indexOf("## Sub")
        const idxBody = lines.indexOf("just plain text body, no headings here")
        expect(idxSub).toBeGreaterThanOrEqual(0)
        expect(idxBody).toBeGreaterThan(idxSub)
        const h3Lines = lines.filter((l) => /^###\s/.test(l))
        expect(h3Lines).toEqual([])
    })

    test("content with preamble intro + H1 subsection: preamble becomes S own text", async () => {
        const p = write("preamble-intro.md", ["# Article", "intro"])
        await call(p, {
            heading: "Sub",
            content: "Preamble text before any heading\n\n# Inner H1\n\ninner body",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxSub = lines.indexOf("## Sub")
        const idxPreamble = lines.indexOf("Preamble text before any heading")
        const idxInnerH1 = lines.indexOf("### Inner H1")
        const idxInnerBody = lines.indexOf("inner body")
        expect(idxSub).toBeGreaterThanOrEqual(0)
        expect(idxPreamble).toBeGreaterThan(idxSub)
        expect(idxInnerH1).toBeGreaterThan(idxPreamble)
        expect(idxInnerBody).toBeGreaterThan(idxInnerH1)
    })

    test("rebase preserves nesting when content has skipped levels (H1->H3->H6 under new H2)", async () => {
        const p = write("skipped-levels.md", ["# Article", "intro"])
        await call(p, {
            heading: "New Section",
            content: "# Level1\n\nintro1\n\n### Level3\n\nL3 body\n\n###### Level6\n\nL6 body",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxArticle = lines.indexOf("# Article")
        const idxIntro = lines.indexOf("intro")
        const idxNewSection = lines.indexOf("## New Section")
        const idxLevel1 = lines.indexOf("### Level1")
        const idxIntro1 = lines.indexOf("intro1")
        const idxLevel3 = lines.indexOf("##### Level3")
        const idxL3Body = lines.indexOf("L3 body")
        const idxLevel6 = lines.indexOf("###### Level6")
        const idxL6Body = lines.indexOf("L6 body")
        expect(idxArticle).toBeGreaterThanOrEqual(0)
        expect(idxIntro).toBeGreaterThan(idxArticle)
        expect(idxNewSection).toBeGreaterThan(idxIntro)
        expect(idxLevel1).toBeGreaterThan(idxNewSection)
        expect(idxIntro1).toBeGreaterThan(idxLevel1)
        expect(idxLevel3).toBeGreaterThan(idxIntro1)
        expect(idxL3Body).toBeGreaterThan(idxLevel3)
        expect(idxLevel6).toBeGreaterThan(idxL3Body)
        expect(idxL6Body).toBeGreaterThan(idxLevel6)
    })

    test("code fence containing `# fake heading` preserved verbatim (not rebased)", async () => {
        const p = write("code-fence-heading.md", ["# Article", "intro"])
        await call(p, {
            heading: "Demo",
            content: "Intro line\n\n```bash\n# fake heading\nsudo apt install\n```\n\n## Real Sub\n\nbody text",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxDemo = lines.indexOf("## Demo")
        const idxIntroLine = lines.indexOf("Intro line")
        const idxFenceStart = lines.indexOf("```bash")
        const idxFakeHeading = lines.indexOf("# fake heading")
        const idxSudo = lines.indexOf("sudo apt install")
        const idxFenceEnd = lines.indexOf("```")
        const idxRealSub = lines.indexOf("### Real Sub")
        const idxBodyText = lines.indexOf("body text")
        expect(idxDemo).toBeGreaterThanOrEqual(0)
        expect(idxIntroLine).toBeGreaterThan(idxDemo)
        expect(idxFenceStart).toBeGreaterThan(idxIntroLine)
        expect(idxFakeHeading).toBeGreaterThan(idxFenceStart)
        expect(idxSudo).toBeGreaterThan(idxFakeHeading)
        expect(idxFenceEnd).toBeGreaterThan(idxSudo)
        expect(idxRealSub).toBeGreaterThan(idxFenceEnd)
        expect(idxBodyText).toBeGreaterThan(idxRealSub)
        expect(f).toContain("# fake heading")
        expect(f).toContain("### Real Sub")
    })

    test("setext-style H1 in content (`Heading\\n===`) rebased to ATX H3 and serialized as ATX", async () => {
        const p = write("setext-h1.md", ["# Article", "intro"])
        await call(p, {
            heading: "New Section",
            content: "Setext Heading\n===\n\nintro body",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxNewSection = lines.indexOf("## New Section")
        const idxSetext = lines.indexOf("### Setext Heading")
        const idxIntroBody = lines.indexOf("intro body")
        const equalsLines = lines.filter((l) => l === "===")
        expect(idxNewSection).toBeGreaterThanOrEqual(0)
        expect(idxSetext).toBeGreaterThan(idxNewSection)
        expect(idxIntroBody).toBeGreaterThan(idxSetext)
        expect(equalsLines).toEqual([])
    })

    test("extreme downward rebase: content with only H6 under new H2 section becomes H3", async () => {
        const p = write("extreme-down.md", ["# Article", "intro"])
        await call(p, {
            heading: "Sub",
            content: "###### Only H6\n\nbody of h6",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxSub = lines.indexOf("## Sub")
        const idxH3 = lines.indexOf("### Only H6")
        const idxBody = lines.indexOf("body of h6")
        expect(idxSub).toBeGreaterThanOrEqual(0)
        expect(idxH3).toBeGreaterThan(idxSub)
        expect(idxBody).toBeGreaterThan(idxH3)
    })

    test("multiple sibling root sections in content all rebased to children of new section", async () => {
        const p = write("multi-siblings.md", ["# Article", "intro"])
        await call(p, {
            heading: "Parent",
            content: "## A\n\nA body\n\n## B\n\nB body\n\n## C\n\nC body",
        })
        const f = readFileSync(p, "utf8")
        const lines = f.split("\n")
        const idxParent = lines.indexOf("## Parent")
        const idxA = lines.indexOf("### A")
        const idxABody = lines.indexOf("A body")
        const idxB = lines.indexOf("### B")
        const idxBBody = lines.indexOf("B body")
        const idxC = lines.indexOf("### C")
        const idxCBody = lines.indexOf("C body")
        expect(idxParent).toBeGreaterThanOrEqual(0)
        expect(idxA).toBeGreaterThan(idxParent)
        expect(idxABody).toBeGreaterThan(idxA)
        expect(idxB).toBeGreaterThan(idxABody)
        expect(idxBBody).toBeGreaterThan(idxB)
        expect(idxC).toBeGreaterThan(idxBBody)
        expect(idxCBody).toBeGreaterThan(idxC)
    })
})
