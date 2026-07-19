import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { resetRetryCounts } from "@/utils/tools"
import { createAutocodeMdFrontmatterReadTool } from "./autocode_md_frontmatter_read"
import { createToolContext } from "./test_context"
import type { ToolContext } from "@opencode-ai/plugin"

type FrontmatterReadTool = ReturnType<typeof createAutocodeMdFrontmatterReadTool>

let oldCwd: string | undefined
let tempDir: string = ""

function useTempCwd(): string {
    tempDir = mkdtempSync(join(tmpdir(), "autocode-fm-read-"))
    oldCwd = process.cwd()
    process.chdir(tempDir)
    return tempDir
}

function parseResult(result: unknown): Record<string, any> {
    const text = typeof result === "string" ? result : (result as { output: string }).output
    return JSON.parse(text)
}

async function execute(
    tool: FrontmatterReadTool,
    args: { file_path_glob: string; [k: string]: unknown },
    context: ToolContext = createToolContext({ directory: tempDir }),
) {
    return parseResult(await tool.execute(args as never, context))
}

afterEach(() => {
    resetRetryCounts()
    if (oldCwd) {
        process.chdir(oldCwd)
        oldCwd = undefined
    }
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true })
        tempDir = ""
    }
})

describe("createAutocodeMdFrontmatterReadTool", () => {
    test("glob *.md returns file_paths with key_paths for each md file with frontmatter", async () => {
        const dir = useTempCwd()
        writeFileSync(`${dir}/a.md`, "---\ntitle: A\nauthor: alice\n---\n# Body\n")
        writeFileSync(`${dir}/b.md`, "---\ntitle: B\n---\n# Body\n")
        const tool = createAutocodeMdFrontmatterReadTool()
        const result = await execute(tool, { file_path_glob: "*.md" })
        expect(Object.keys(result.file_paths).sort()).toEqual(["a.md", "b.md"])
        expect(result.file_paths["a.md"].key_paths["title"]).toBe("A")
        expect(result.file_paths["a.md"].key_paths["author"]).toBe("alice")
        expect(result.file_paths["b.md"].key_paths["title"]).toBe("B")
        expect(result.file_paths["a.md"].nodes_shown).toBe(2)
        expect(result.file_paths["a.md"].nodes_total).toBe(2)
    })

    test("key_regex filters nodes by key segment", async () => {
        const dir = useTempCwd()
        writeFileSync(`${dir}/deep.md`, "---\nnested:\n  child: deepvalue\n  other: kept\n---\nbody\n")
        const tool = createAutocodeMdFrontmatterReadTool()
        const result = await execute(tool, { file_path_glob: "deep.md", key_regex: "child" })
        expect(result.file_paths["deep.md"].key_paths["nested.child"]).toBe("deepvalue")
        expect(result.file_paths["deep.md"].key_paths["nested.other"]).toBeUndefined()
    })

    test("skips .md file without frontmatter", async () => {
        const dir = useTempCwd()
        writeFileSync(`${dir}/fm.md`, "---\ntitle: Has\n---\nbody")
        writeFileSync(`${dir}/nofm.md`, "# Just body\n")
        const tool = createAutocodeMdFrontmatterReadTool()
        const result = await execute(tool, { file_path_glob: "*.md" })
        expect(Object.keys(result.file_paths)).toEqual(["fm.md"])
    })

    test("skips non-.md file and yields retry error when no .md with frontmatter matches", async () => {
        const dir = useTempCwd()
        writeFileSync(`${dir}/data.json`, "{\"title\": \"x\"}")
        const tool = createAutocodeMdFrontmatterReadTool()
        const result = await execute(tool, { file_path_glob: "*.json" })
        expect(result.file_paths).toBeUndefined()
        expect(result.failedAction).toBe("Read frontmatter")
        expect(typeof result.error).toBe("string")
    })

    test("non-match glob returns retry JSON error", async () => {
        useTempCwd()
        const tool = createAutocodeMdFrontmatterReadTool()
        const result = await execute(tool, { file_path_glob: "nope/*.md" })
        expect(result.failedAction).toBe("Read frontmatter")
        expect(typeof result.error).toBe("string")
        expect(result.file_paths).toBeUndefined()
    })

    test("value_regex filters leaf values", async () => {
        const dir = useTempCwd()
        writeFileSync(`${dir}/vp.md`, "---\na: hello\nb: world\nc: 42\n---\nbody")
        const tool = createAutocodeMdFrontmatterReadTool()
        const result = await execute(tool, { file_path_glob: "vp.md", value_regex: "orld|ello" })
        // only leaves are emitted; a and b match; c (42) is excluded
        expect(result.file_paths["vp.md"].nodes_total).toBe(2)
        expect(result.file_paths["vp.md"].key_paths["a"]).toBe("hello")
        expect(result.file_paths["vp.md"].key_paths["b"]).toBe("world")
        expect(result.file_paths["vp.md"].key_paths["c"]).toBeUndefined()
    })

    test("max_keys truncation reflected in nodes_shown vs nodes_total", async () => {
        const dir = useTempCwd()
        writeFileSync(`${dir}/big.md`, "---\na: 1\nb: 2\nc: 3\nd: 4\ne: 5\n---\nbody")
        const tool = createAutocodeMdFrontmatterReadTool()
        const result = await execute(tool, { file_path_glob: "big.md", max_keys: 2 })
        expect(result.file_paths["big.md"].nodes_shown).toBe(2)
        // 5 leaves emitted (root parent is no longer counted)
        expect(result.file_paths["big.md"].nodes_total).toBe(5)
    })

    test("throws when context.directory is missing", async () => {
        useTempCwd()
        const tool = createAutocodeMdFrontmatterReadTool()
        await expect(
            tool.execute({ file_path_glob: "*.md" } as never, createToolContext({ directory: "" })),
        ).rejects.toThrow(/autocode_md_frontmatter_read.*context\.directory/)
    })

    test("max_keys applies globally across multiple files", async () => {
        const dir = useTempCwd()
        writeFileSync(`${dir}/a.md`, "---\nx: 1\ny: 2\n---\nbody")
        writeFileSync(`${dir}/b.md`, "---\nx: 1\ny: 2\n---\nbody")
        const tool = createAutocodeMdFrontmatterReadTool()
        const result = await execute(tool, { file_path_glob: "*.md", max_keys: 4 })
        // 2 files x 2 leaves each = 4 total; global cap shows 4
        expect(result.nodes_shown).toBe(4)
        expect(result.nodes_total).toBe(4)
        expect(result.truncated).toBe(false)
    })
})
