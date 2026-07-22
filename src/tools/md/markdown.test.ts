import { describe, expect, test } from "bun:test"
import { buildOutline, parseMarkdown, rebuildFile } from "./markdown"
import { serializeTree } from "./transform"

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
