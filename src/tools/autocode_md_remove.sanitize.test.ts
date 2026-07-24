import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAutocodeMdRemoveTool } from "./autocode_md_remove"
import { createToolContext } from "./test_context"

describe("sanitize stray empty headings", () => {
    let dir: string
    let oldCwd: string
    const tool = createAutocodeMdRemoveTool()
    beforeEach(() => {
        oldCwd = process.cwd()
        dir = mkdtempSync(join(tmpdir(), "md-remove-sanitize-"))
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
    const remove = (p: string, args: Record<string, unknown>) =>
        tool.execute({ file_path: p, ...args } as never, createToolContext({ directory: dir })).then((s) => JSON.parse(s as string))

    test("removing an H2 sibling next to a malformed \"## \" orphan leaves no stray empty heading", async () => {
        const p = write("orphan-space.md", ["# Top", "", "## ", "", "## Beta", "", "beta body"])
        await remove(p, { anchor: "Beta" })
        const f = readFileSync(p, "utf8")
        expect(f).not.toContain("## Beta")
        expect(f).not.toContain("beta body")
        expect(f).not.toMatch(/^#{1,6}\s*$/m)
        expect(f).toContain("# Top")
    })

    test("removing an H2 sibling next to a bare \"##\" (no space) orphan leaves no stray empty heading", async () => {
        const p = write("orphan-bare.md", ["# Top", "", "##", "", "## Beta", "", "beta body"])
        await remove(p, { anchor: "Beta" })
        const f = readFileSync(p, "utf8")
        expect(f).not.toMatch(/^#{1,6}\s*$/m)
        expect(f).not.toContain("## Beta")
    })

    test("fenced code block containing \"## \" lines is preserved after sibling removal", async () => {
        const p = write("fence.md", ["# Top", "", "```bash", "## ", "echo hi", "```", "", "## Other", "", "other text"])
        await remove(p, { anchor: "Other" })
        const f = readFileSync(p, "utf8")
        expect(f).toContain("```bash")
        expect(f).toContain("## ")
        expect(f).toContain("echo hi")
        expect(f).toContain("```")
        expect(f).not.toContain("## Other")
        expect(f).not.toContain("other text")
    })

    test("removing the only valid H2 next to a malformed \"## \" leaves just the parent heading", async () => {
        const p = write("only-child.md", ["# Top", "", "## ", "", "## Beta", "", "beta body"])
        await remove(p, { anchor: "Beta" })
        const f = readFileSync(p, "utf8")
        expect(f).toBe("# Top\n")
    })
})
