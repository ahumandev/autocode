import { describe, expect, test } from "bun:test"
import { ownText, parseMarkdown, rebuildFile } from "./markdown"
import { serializeTree } from "./transform"

describe("sanitize stray empty headings", () => {
    test("serializeTree drops an orphan \"## \" line from parent intro when sibling removed", () => {
        const raw = "# Top\n\n## \n\n## Beta\n\nbeta body\n"
        const m = parseMarkdown(raw)
        const top = m.headings.find((h) => h.title === "Top")!
        const beta = m.headings.find((h) => h.title === "Beta")!
        const overrides = new Map()
        for (const h of m.headings) overrides.set(h, ownText(m, h))
        const idx = top.children.indexOf(beta)
        if (idx >= 0) top.children.splice(idx, 1)
        const out = serializeTree(m, overrides)
        const rebuilt = rebuildFile(m, out)
        expect(rebuilt).not.toMatch(/^#{1,6}\s*$/m)
        expect(rebuilt).not.toContain("## Beta")
        expect(rebuilt).toContain("# Top")
    })

    test("serializeTree preserves fenced ``` block containing stray \"##\" lines", () => {
        const raw = "# Top\n\n```bash\n##\n## \necho hi\n```\n\n## Other\n\nother text\n"
        const m = parseMarkdown(raw)
        const top = m.headings.find((h) => h.title === "Top")!
        const other = m.headings.find((h) => h.title === "Other")!
        const overrides = new Map()
        for (const h of m.headings) overrides.set(h, ownText(m, h))
        const idx = top.children.indexOf(other)
        if (idx >= 0) top.children.splice(idx, 1)
        const out = serializeTree(m, overrides)
        const rebuilt = rebuildFile(m, out)
        expect(rebuilt).toContain("```bash")
        expect(rebuilt).toContain("##")
        expect(rebuilt).toContain("## ")
        expect(rebuilt).toContain("echo hi")
        expect(rebuilt).not.toContain("## Other")
    })

    test("serializeTree keeps normal valid \"# Title\" heading lines unchanged", () => {
        const raw = "# A\n\nintro\n\n## B\n\nb body\n"
        const m = parseMarkdown(raw)
        const out = serializeTree(m)
        expect(out).toBe("# A\n\nintro\n\n## B\n\nb body\n")
    })

    test("serializeTree collapses triple newlines produced by dropped stray lines back to one blank line", () => {
        const raw = "# A\n\n##\n\n##\n\n## B\n\nb\n"
        const m = parseMarkdown(raw)
        const a = m.headings.find((h) => h.title === "A")!
        const b = m.headings.find((h) => h.title === "B")!
        const overrides = new Map()
        for (const h of m.headings) overrides.set(h, ownText(m, h))
        const idx = a.children.indexOf(b)
        if (idx >= 0) a.children.splice(idx, 1)
        const out = serializeTree(m, overrides)
        const rebuilt = rebuildFile(m, out)
        expect(rebuilt).not.toMatch(/\n{3,}/)
        expect(rebuilt).not.toContain("## B")
        expect(rebuilt).toContain("# A")
    })
})
