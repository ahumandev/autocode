import { describe, expect, test } from "bun:test"
import { buildOutline, normalizeHeadingText, parseMarkdown, rebuildFile, slugifyHeading } from "./markdown"
import { serializeTree } from "./transform"

describe("normalizeHeadingText", () => {
    test.each([1, 2, 3, 4, 5, 6])("strips %d-hash opening marker", (n) => {
        const hashes = "#".repeat(n)
        expect(normalizeHeadingText(`${hashes} My Title`)).toBe("My Title")
        expect(slugifyHeading(normalizeHeadingText(`${hashes} My Title`))).toBe("my-title")
    })

    test("strips surrounding and delimiter whitespace", () => {
        expect(normalizeHeadingText("  ##\t  My Title  ")).toBe("My Title")
    })

    test("preserves plain titles, hashtags, C# and non-heading hash runs", () => {
        expect(normalizeHeadingText("My Title")).toBe("My Title")
        expect(normalizeHeadingText("#hashtag")).toBe("#hashtag")
        expect(normalizeHeadingText("##hashtag")).toBe("##hashtag")
        expect(normalizeHeadingText("C#")).toBe("C#")
        expect(normalizeHeadingText("C# Guide")).toBe("C# Guide")
        expect(normalizeHeadingText("####### Seven")).toBe("####### Seven")
    })

    test("strips only one marker and keeps trailing hashes", () => {
        expect(normalizeHeadingText("## # Title")).toBe("# Title")
        expect(normalizeHeadingText("## Title ##")).toBe("Title ##")
    })

    test("marker-only or blank input becomes empty", () => {
        expect(normalizeHeadingText("#")).toBe("")
        expect(normalizeHeadingText("  ######  ")).toBe("")
        expect(normalizeHeadingText("   ")).toBe("")
        expect(normalizeHeadingText("")).toBe("")
    })
})

describe("rebuildFile blank-line boundary", () => {
    test("frontmatter and single heading have exactly 1 blank line between", () => {
        const raw = "---\ntitle: Doc\n---\n# Title\n\nBody text\n"
        const model = parseMarkdown(raw)
        const out = rebuildFile(model, serializeTree(model))

        expect(out).toMatch(/---\n\n# Title/)
        expect(out).not.toMatch(/---\n# Title/)
        expect(out).not.toMatch(/---\n\n\n# Title/)
    })

    test("frontmatter and multi-heading doc have exactly 1 blank line at every heading boundary", () => {
        const raw = "---\ntitle: Doc\n---\n# Title\n\nBody text\n\n## Sub\n\nMore\n"
        const model = parseMarkdown(raw)
        const out = rebuildFile(model, serializeTree(model))

        expect(out).toMatch(/---\n\n# Title/)
        expect(out).toMatch(/Body text\n\n## Sub/)
        expect(out).not.toMatch(/---\n# Title/)
        expect(out).not.toMatch(/---\n\n\n# Title/)
        expect(out).not.toMatch(/## Sub\n#/)
        expect(out).not.toMatch(/## Sub\n\n\n#/)
    })

    test("doc without frontmatter is unchanged and has no leading blank line", () => {
        const raw = "# Title\n\nBody text\n"
        const model = parseMarkdown(raw)
        const out = rebuildFile(model, serializeTree(model))

        expect(out).toBe(raw)
        expect(out.startsWith("\n")).toBe(false)
    })
})

describe("buildOutline", () => {
    test("keeps nested headings without line metadata", () => {
        const outline = buildOutline(parseMarkdown("# Root\n\n## Child\n\n### Grandchild\n"))

        expect(outline).toEqual({ root: { child: { grandchild: {} } } })
        expect(JSON.stringify(outline)).not.toContain("_lines")
    })
})
