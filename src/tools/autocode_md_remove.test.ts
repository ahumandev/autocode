import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAutocodeMdRemoveTool } from "./autocode_md_remove"
import { createToolContext } from "./test_context"

describe("autocode_md_remove", () => {
    let dir: string
    let oldCwd: string
    const tool = createAutocodeMdRemoveTool()
    beforeEach(() => {
        oldCwd = process.cwd()
        dir = mkdtempSync(join(tmpdir(), "md-remove-"))
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

    test("leaf removal: section with no children is gone, rest intact", async () => {
        const p = write("leaf.md", ["# A", "", "a text", "", "## B", "", "b text"])
        const r = await remove(p, { anchor: "B" })
        const f = readFileSync(p, "utf8")
        expect(f).not.toContain("## B")
        expect(f).not.toContain("b text")
        expect(f).toContain("a text")
        expect(r.outline.a.b).toBeUndefined()
    })

    test("subtree removal: entire subtree gone (no orphaned children)", async () => {
        const p = write("sub.md", ["# A", "", "a text", "", "## B", "", "b text", "", "### C", "", "c text", "", "## D", "", "d text"])
        await remove(p, { anchor: "B" })
        const f = readFileSync(p, "utf8")
        expect(f).not.toContain("## B")
        expect(f).not.toContain("### C")
        expect(f).not.toContain("b text")
        expect(f).not.toContain("c text")
        expect(f).toContain("## D")
        expect(f).toContain("d text")
    })

    test("post-removal outline has the {file_path, outline} shape", async () => {
        const p = write("shape.md", ["# A", "", "a", "", "## B", "", "b"])
        const r = await remove(p, { anchor: "B" })
        expect(r).toHaveProperty("file_path", p)
        expect(r).toHaveProperty("outline")
        expect(typeof r.outline).toBe("object")
    })

    test("missing title error", async () => {
        const p = write("miss.md", ["# A", "", "a text"])
        const r = await remove(p, { anchor: "Nope" })
        expect(r.failedAction).toBe("autocode_md_remove")
        expect(r.instruction).toContain("not found")
    })

    test("ambiguous title error for duplicates without [n]", async () => {
        const p = write("amb.md", ["# Dup", "", "a", "", "# Dup", "", "b"])
        const r = await remove(p, { anchor: "Dup" })
        expect(r.failedAction).toBe("autocode_md_remove")
        expect(r.instruction).toContain("[n]")
    })
})
