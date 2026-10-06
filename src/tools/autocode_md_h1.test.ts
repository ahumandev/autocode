import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAutocodeMdH1Tool } from "./autocode_md_h1"
import { createToolContext } from "./test_context"

describe("autocode_md_h1", () => {
    let dir: string
    let oldCwd: string
    const tool = createAutocodeMdH1Tool()
    beforeEach(() => {
        oldCwd = process.cwd()
        dir = mkdtempSync(join(tmpdir(), "md-h1-"))
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

    test("sets title/intro/preamble in empty file", async () => {
        const p = write("full.md", [""])
        await call(p, { title: "My Article", intro: "Welcome", preamble: "Some preamble" })
        const f = readFileSync(p, "utf8")
        expect(f).toBe("Some preamble\n\n# My Article\n\nWelcome\n")
    })

    test("creating H1 in empty file: empty intro and empty preamble produce just # title\n", async () => {
        const p = write("title-only.md", [""])
        await call(p, { title: "My Article" })
        const f = readFileSync(p, "utf8")
        expect(f).toBe("# My Article\n")
    })

    test("creates H1 prepended before existing H2 sections (no H1)", async () => {
        const p = write("no-h1.md", ["## Sub1", "body1", "", "## Sub2", "body2"])
        await call(p, { title: "Article" })
        const f = readFileSync(p, "utf8")
        const idxH1 = f.indexOf("# Article")
        const idxSub1 = f.indexOf("## Sub1")
        const idxSub2 = f.indexOf("## Sub2")
        expect(idxH1).toBeGreaterThanOrEqual(0)
        expect(idxSub1).toBeGreaterThan(idxH1)
        expect(idxSub2).toBeGreaterThan(idxSub1)
    })

    test("preserves preamble when only H1 exists", async () => {
        const p = write("h1-only.md", ["intro text", "", "# Existing", "old intro", "", "## Sub", "body"])
        await call(p, { title: "New" })
        const f = readFileSync(p, "utf8")
        expect(f).toContain("intro text")
        expect(f).toContain("old intro")
        expect(f).toMatch(/^# New$/m)
        expect(f).toContain("## Sub")
        expect(f).toContain("body")
        expect(f).not.toMatch(/^# Existing$/m)
    })

    test("updates only title - preserves intro and preamble", async () => {
        const p = write("title-update.md", ["intro text", "", "# Existing", "old intro", "", "## Sub", "body"])
        await call(p, { title: "New" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^# New$/m)
        expect(f).toContain("old intro")
        expect(f).toContain("intro text")
        expect(f).not.toMatch(/^# Existing$/m)
    })

    test("updates only intro - preserves title and preamble", async () => {
        const p = write("intro-update.md", ["intro text", "", "# Existing", "old intro", "", "## Sub", "body"])
        await call(p, { intro: "new intro" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^# Existing$/m)
        expect(f).toContain("intro text")
        expect(f).toContain("new intro")
        expect(f).not.toContain("old intro")
    })

    test("updates only preamble - preserves title and intro", async () => {
        const p = write("preamble-update.md", ["intro text", "", "# Existing", "old intro", "", "## Sub", "body"])
        await call(p, { preamble: "preamble only" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^# Existing$/m)
        expect(f).toContain("old intro")
        expect(f).toContain("preamble only")
        expect(f).not.toContain("intro text")
    })

    test("preserves H2 subsections under H1 when updating H1 text", async () => {
        const p = write("with-sub.md", ["# Original", "intro line", "", "## Subsection", "sub body", "", "### Deep", "deep body"])
        await call(p, { title: "Renamed" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^# Renamed$/m)
        expect(f).toContain("## Subsection")
        expect(f).toContain("sub body")
        expect(f).toContain("### Deep")
        expect(f).toContain("deep body")
    })

    test("no-op when args omitted - file unchanged", async () => {
        const p = write("noop.md", ["# Existing", "intro", "", "## Sub", "body"])
        const before = readFileSync(p, "utf8")
        await call(p, {})
        const after = readFileSync(p, "utf8")
        expect(after).toBe(before)
    })

    test("missing title error when no H1 exists and title arg omitted", async () => {
        const p = write("missing-title.md", [""])
        const r = await call(p, { intro: "hello" })
        expect(r.failedAction).toBe("autocode_md_h1")
        expect(r.instruction).toContain("title is required when there is no H1 in file yet")
    })

    test("operates on first H1 silently when multiple H1s present", async () => {
        const p = write("multi-h1.md", ["# First", "intro1", "", "# Second", "intro2", "", "## Sub", "body"])
        await call(p, { title: "Updated" })
        const f = readFileSync(p, "utf8")
        expect(f).toMatch(/^# Updated$/m)
        expect(f).toMatch(/^# Second$/m)
        expect(f).not.toMatch(/^# First$/m)
    })

    test("frontmatter untouched when updating title", async () => {
        const p = write("with-fm.md", ["---", "title: doc", "---", "", "# Heading", "intro"])
        await call(p, { title: "New Title" })
        const f = readFileSync(p, "utf8")
        expect(f.startsWith("---\ntitle: doc\n---")).toBe(true)
        expect(f).toMatch(/^# New Title$/m)
        expect(f).toContain("intro")
    })

    describe("title hash normalization", () => {
        test.each([1, 2, 3, 4, 5, 6])("existing H1 renamed with %d-hash prefix stays single H1", async (n) => {
            const p = write(`prefix-existing-${n}.md`, ["# Old", "intro", "", "## Sub", "body"])
            const r = await call(p, { title: `${"#".repeat(n)} New Title` })
            const f = readFileSync(p, "utf8")
            expect(f).toBe("# New Title\n\nintro\n\n## Sub\n\nbody\n")
            expect(r.outline["new-title"]).toBeDefined()
        })

        test.each([1, 2, 3, 4, 5, 6])("new H1 with %d-hash prefix created without duplicated hashes", async (n) => {
            const p = write(`prefix-new-${n}.md`, [""])
            const r = await call(p, { title: `${"#".repeat(n)} Fresh Title` })
            expect(readFileSync(p, "utf8")).toBe("# Fresh Title\n")
            expect(r.outline["fresh-title"]).toBeDefined()
        })

        test("new prefixed H1 prepended before existing H2 sections", async () => {
            const p = write("prefix-no-h1.md", ["## Sub1", "body1"])
            await call(p, { title: "## Article" })
            const f = readFileSync(p, "utf8")
            expect(f).toMatch(/^# Article$/m)
            expect(f).not.toMatch(/^#+ #+ /m)
            expect(f.indexOf("# Article")).toBeLessThan(f.indexOf("## Sub1"))
        })

        test("surrounding and delimiter whitespace trimmed", async () => {
            const p = write("prefix-ws.md", [""])
            await call(p, { title: "  ##  \t Spaced Title  " })
            expect(readFileSync(p, "utf8")).toBe("# Spaced Title\n")
        })

        test("plain, hashtag and C# titles preserved", async () => {
            const p = write("prefix-preserve.md", [""])
            await call(p, { title: "Plain Title" })
            expect(readFileSync(p, "utf8")).toBe("# Plain Title\n")
            await call(p, { title: "#hashtag" })
            expect(readFileSync(p, "utf8")).toBe("# #hashtag\n")
            await call(p, { title: "C#" })
            expect(readFileSync(p, "utf8")).toBe("# C#\n")
        })

        test("hash-only title returns error and does not modify file", async () => {
            const p = write("prefix-blank.md", ["# Existing", "intro"])
            const before = readFileSync(p, "utf8")
            for (const title of ["#", "  ##  ", "######"]) {
                const r = await call(p, { title, intro: "changed", preamble: "pre" })
                expect(r.failedAction).toBe("autocode_md_h1")
                expect(r.instruction).toContain("title")
            }
            expect(readFileSync(p, "utf8")).toBe(before)
        })

        test("hash-only title does not create H1 in empty file", async () => {
            const p = write("prefix-blank-empty.md", [""])
            const before = readFileSync(p, "utf8")
            const r = await call(p, { title: "###" })
            expect(r.failedAction).toBe("autocode_md_h1")
            expect(readFileSync(p, "utf8")).toBe(before)
        })

        test("preamble, intro and subsections unaffected by prefixed title", async () => {
            const p = write("prefix-keep.md", ["pre #tag", "", "# Old", "intro #1", "", "## Sub", "body"])
            await call(p, { title: "# New" })
            const f = readFileSync(p, "utf8")
            expect(f).toBe("pre #tag\n\n# New\n\nintro #1\n\n## Sub\n\nbody\n")
        })
    })
})
