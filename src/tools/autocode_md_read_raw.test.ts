import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { isPathWithin } from "@/utils/memory_access"
import { resetRetryCounts } from "@/utils/tools"
import { createAutocodeMdReadTool } from "./autocode_md_read"
import { createToolContext } from "./test_context"

const temporaryDirectory = process.env.TEMP || tmpdir()

function supportsLink(kind: "file" | "dir" | "hard"): boolean {
    const root = mkdtempSync(path.join(temporaryDirectory, "md-read-link-probe-"))
    try {
        const target = path.join(root, "target")
        if (kind === "dir") mkdirSync(target)
        else writeFileSync(target, "synthetic")
        try {
            if (kind === "hard") linkSync(target, path.join(root, "link"))
            else symlinkSync(target, path.join(root, "link"), kind === "dir" && process.platform === "win32" ? "junction" : kind)
            return true
        } catch (error) {
            if (typeof error === "object" && error !== null && "code" in error
                && ["EACCES", "EPERM", "EINVAL", "EROFS", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(String(error.code))) return false
            throw error
        }
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

const supportsFileLink = supportsLink("file")
const supportsDirectoryLink = supportsLink("dir")
const supportsHardLink = supportsLink("hard")
async function resolvesHardLinkInsideMemory(): Promise<boolean> {
    const root = mkdtempSync(path.join(temporaryDirectory, "md-read-hardlink-probe-"))
    try {
        const memory = path.join(root, "memory")
        const target = path.join(root, "outside.md")
        const link = path.join(memory, "INDEX.md")
        mkdirSync(memory)
        writeFileSync(target, "synthetic")
        linkSync(target, link)
        return isPathWithin(await realpath(memory), await realpath(link))
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}
const hardLinkResolvesInsideMemory = supportsHardLink && await resolvesHardLinkInsideMemory()
const denyExternal = [{ action: "external_directory", resource: "*", effect: "deny" }] as const

describe("dynamic Markdown reads and configured memory index", () => {
    let root: string
    let project: string
    let memory: string
    let legacy: string
    const canary = "Synthetic legacy canary 🧪\n"

    beforeEach((): void => {
        root = mkdtempSync(path.join(temporaryDirectory, "md-read-memory-"))
        project = path.join(root, "project")
        memory = path.join(root, "memory")
        legacy = path.join(project, ".opencode", "autocode", "memories", "INDEX.md")
        mkdirSync(memory, { recursive: true })
        mkdirSync(path.dirname(legacy), { recursive: true })
        writeFileSync(legacy, canary)
    })

    afterEach((): void => {
        resetRetryCounts()
        rmSync(root, { recursive: true, force: true })
    })

    async function read(file: string, configured: string | undefined = memory, extra: Record<string, unknown> = {}, agent = "query-memory"): Promise<Record<string, unknown>> {
        const context = Object.assign(createToolContext({ directory: project, worktree: project, agent }), { externalDirectoryPermissions: denyExternal })
        const result = await createAutocodeMdReadTool(configured).execute({ file_path_glob: file, ...extra } as never, context)
        return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
    }

    test("returns complete UTF-8 indexes for absolute and project-relative requests", async (): Promise<void> => {
        const index = path.join(memory, "INDEX.md")
        const contents = ["", "headingless 🧪\r\nsecond line\r\n", "preamble\r\n\r\n# Heading\r\nbody\n", `前書き\n${"é🙂漢字\r\n".repeat(12000)}終`, '{"error":"synthetic index text"}']
        for (const content of contents) {
            writeFileSync(index, content, "utf8")
            for (const file of [index, path.relative(project, index)]) {
                expect(await read(file)).toEqual({ content })
            }
        }
        expect(readFileSync(legacy, "utf8")).toBe(canary)
    })

    test("expands wildcards across multiple files while an exact index returns complete content", async (): Promise<void> => {
        const index = path.join(memory, "INDEX.md")
        const other = path.join(memory, "INDEX1.md")
        const nested = path.join(memory, "nested")
        const child = path.join(nested, "child.md")
        mkdirSync(nested)
        writeFileSync(index, "preamble\n# Index\n\nIndex body\n")
        writeFileSync(other, "# Other\n\nOther body\n")
        writeFileSync(child, "# Child\n\nChild body\n")
        expect(await read(index)).toEqual({ content: "preamble\n# Index\n\nIndex body\n" })
        expect(await read(path.join(memory, "INDEX*.md"))).toEqual({
            file_paths: {
                [index]: [{ anchor: "index", line_of_heading: 2, line_count: 4, index: 0 }],
                [other]: [{ anchor: "other", line_of_heading: 1, line_count: 4, index: 0 }],
            },
        })
        for (const pattern of [path.join(memory, "INDEX*.md"), path.relative(project, path.join(memory, "INDEX*.md"))]) {
            const result = await read(pattern, memory, { max_content_chars: 4000 })
            expect(result.content).toBeUndefined()
            expect(result.file_paths).toEqual({
                [index]: [{ anchor: "index", line_of_heading: 2, line_count: 4, index: 0, content: "Index body" }],
                [other]: [{ anchor: "other", line_of_heading: 1, line_count: 4, index: 0, content: "Other body" }],
            })
        }
        const recursive = await read(path.join(memory, "**", "*.md"), memory, { max_content_chars: 4000 })
        const paths = recursive.file_paths as Record<string, unknown>
        expect(Object.keys(paths).sort()).toEqual([index, other, child].sort())
        expect(paths[child]).toEqual([{ anchor: "child", line_of_heading: 1, line_count: 4, index: 0, content: "Child body" }])
    })

    test.each(["query-memory", "learn-memory"])("%s supports default, project-relative and external configured roots", async (agent): Promise<void> => {
        for (const configured of [undefined, "notes/memory", memory]) {
            const directory = configured === undefined ? path.join(project, ".opencode", "autocode", "memory") : path.resolve(project, configured)
            mkdirSync(directory, { recursive: true })
            const index = path.join(directory, "INDEX.md")
            writeFileSync(index, "authorized")
            const context = Object.assign(createToolContext({ directory: project, worktree: project, agent }), { externalDirectoryPermissions: denyExternal })
            const tool = createAutocodeMdReadTool(configured)
            for (const file of [index, path.relative(project, index)]) {
                const result = await tool.execute({ file_path_glob: file } as never, context)
                expect(JSON.parse(typeof result === "string" ? result : result.output)).toEqual({ content: "authorized" })
            }
        }
        expect(readFileSync(legacy, "utf8")).toBe(canary)
    })

    test("uses ordinary Markdown output for filtered index and non-memory requests", async (): Promise<void> => {
        const index = path.join(memory, "INDEX.md")
        writeFileSync(index, "preamble\n# Index\n\nIndex body\n")
        const outline = [{ anchor: "index", line_of_heading: 2, line_count: 4, index: 0 }]
        expect(await read(index, memory, { max_anchors: 2 })).toEqual({ file_paths: { [index]: outline } })
        expect(await read(index, memory, { anchor_regex: "^index$", max_content_chars: 4000 })).toEqual({
            file_paths: { [index]: [{ ...outline[0], content: "Index body" }] },
        })
        expect(await read(index, memory, {}, "build")).toEqual({ file_paths: { [index]: outline } })
        expect(await read(index, memory, { line_start: 1, line_end: Number.MAX_SAFE_INTEGER, max_anchors: 40, max_content_chars: 0 })).toEqual({ content: "preamble\n# Index\n\nIndex body\n" })
    })

    test("reports missing matches and unsafe non-directory paths", async (): Promise<void> => {
        const missing = path.join(memory, "missing.md")
        const missingRoot = path.join(root, "absent")
        for (const [file, configured] of [[missing, memory], [path.join(missingRoot, "INDEX.md"), missingRoot]] as const) {
            const result = await read(file, configured)
            expect(result.failedAction).toBe("Read md section")
            expect(result.error).toBe(`no files matched glob: ${file}`)
            expect(result.content).toBeUndefined()
            expect(result.file_paths).toBeUndefined()
        }
        const parent = path.join(memory, "not-a-directory")
        writeFileSync(parent, "synthetic")
        const invalid = await read(path.join(parent, "INDEX.md"))
        expect(invalid.failedAction).toBe("Read md section")
        expect(invalid.error).toContain("cannot be resolved safely")
        expect(invalid.content).toBeUndefined()
        expect(invalid.file_paths).toBeUndefined()
    })

    test.each(["query-memory", "learn-memory"])("%s denies unrelated, sibling, traversal and legacy paths", async (agent): Promise<void> => {
        const sibling = `${memory}-sibling`
        mkdirSync(sibling)
        const outside = path.join(root, "outside.md")
        const siblingIndex = path.join(sibling, "INDEX.md")
        const projectIndex = path.join(project, "INDEX.md")
        writeFileSync(outside, "outside canary")
        writeFileSync(siblingIndex, "sibling canary")
        writeFileSync(projectIndex, "project canary")
        const traversal = `${memory}${path.sep}..${path.sep}${path.basename(sibling)}${path.sep}INDEX.md`
        for (const file of [outside, siblingIndex, traversal, legacy, "INDEX.md"]) {
            const result = await read(file, memory, {}, agent)
            expect(result.failedAction).toBe("Read md section")
            expect(result.error).toContain("cannot be accessed safely")
            expect(result.content).toBeUndefined()
            expect(result.file_paths).toBeUndefined()
            expect(JSON.stringify(result)).not.toContain(canary.trim())
        }
        expect(readFileSync(legacy, "utf8")).toBe(canary)
        expect(readFileSync(outside, "utf8")).toBe("outside canary")
        expect(readFileSync(siblingIndex, "utf8")).toBe("sibling canary")
        expect(readFileSync(projectIndex, "utf8")).toBe("project canary")
    })

    test("reads only the literal absolute index when its root resembles a multiple-match glob", async (): Promise<void> => {
        const unusual = path.join(root, "memory[12]")
        const lookalikes = [path.join(root, "memory1"), path.join(root, "memory2")]
        mkdirSync(unusual)
        for (const lookalike of lookalikes) {
            mkdirSync(lookalike)
            writeFileSync(path.join(lookalike, "INDEX.md"), "lookalike canary")
        }
        const index = path.join(unusual, "INDEX.md")
        writeFileSync(index, "literal index")
        expect(await read(index, unusual)).toEqual({ content: "literal index" })
        for (const lookalike of lookalikes) expect(readFileSync(path.join(lookalike, "INDEX.md"), "utf8")).toBe("lookalike canary")
        const wildcard = await read(path.join(unusual, "*.md"), unusual)
        expect(wildcard.error).toContain("cannot be accessed safely")
        expect(wildcard.content).toBeUndefined()
        expect(wildcard.file_paths).toBeUndefined()
    })

    test("reads the project-relative literal index under a glob-metacharacter root", async (): Promise<void> => {
        const configured = "memory[synthetic]"
        const directory = path.join(project, configured)
        mkdirSync(directory)
        const index = path.join(directory, "INDEX.md")
        const content = "Synthetic preamble\n# Index\n\nComplete index\n"
        writeFileSync(index, content)
        expect(await read(index, configured)).toEqual({ content })
        expect(await read(path.join(configured, "INDEX.md"), configured)).toEqual({ content })
        expect(readFileSync(index, "utf8")).toBe(content)
    })

    test.skipIf(!supportsFileLink)("denies file symlinks escaping memory", async (): Promise<void> => {
        const outside = path.join(root, "outside.md")
        const link = path.join(memory, "INDEX.md")
        writeFileSync(outside, "outside canary")
        symlinkSync(outside, link, "file")
        const result = await read(link)
        expect(result.error).toContain("cannot be accessed safely")
        expect(result.content).toBeUndefined()
        expect(result.file_paths).toBeUndefined()
        expect(readFileSync(outside, "utf8")).toBe("outside canary")
    })

    test.skipIf(!supportsDirectoryLink)("denies directory links escaping memory, including missing descendants", async (): Promise<void> => {
        const outside = path.join(root, "outside")
        mkdirSync(outside)
        writeFileSync(path.join(outside, "INDEX.md"), "outside canary")
        const link = path.join(memory, "escape")
        symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
        for (const name of ["INDEX.md", "missing.md"]) {
            const result = await read(path.join(link, name))
            expect(result.error).toContain("cannot be accessed safely")
            expect(result.content).toBeUndefined()
            expect(result.file_paths).toBeUndefined()
        }
        expect(readFileSync(path.join(outside, "INDEX.md"), "utf8")).toBe("outside canary")
    })

    test.skipIf(!supportsDirectoryLink)("allows a configured directory link without authorizing its target path", async (): Promise<void> => {
        const alias = path.join(project, "alias")
        const index = path.join(memory, "INDEX.md")
        writeFileSync(index, "linked root")
        symlinkSync(memory, alias, process.platform === "win32" ? "junction" : "dir")
        expect(await read(path.join(alias, "INDEX.md"), alias)).toEqual({ content: "linked root" })
        const denied = await read(index, alias)
        expect(denied.error).toContain("cannot be accessed safely")
        expect(denied.content).toBeUndefined()
    })

    test.skipIf(!hardLinkResolvesInsideMemory)("reads an in-root hardlink as an in-root file", async (): Promise<void> => {
        const outside = path.join(root, "outside.md")
        const index = path.join(memory, "INDEX.md")
        writeFileSync(outside, "synthetic hardlink target")
        linkSync(outside, index)
        expect(await read(index)).toEqual({ content: "synthetic hardlink target" })
        expect(readFileSync(outside, "utf8")).toBe("synthetic hardlink target")
    })

    test.skipIf(!supportsHardLink || hardLinkResolvesInsideMemory)("denies a hardlink resolving outside memory", async (): Promise<void> => {
        const outside = path.join(root, "outside.md")
        const index = path.join(memory, "INDEX.md")
        writeFileSync(outside, "synthetic hardlink target")
        linkSync(outside, index)
        const result = await read(index)
        expect(result.error).toContain("cannot be accessed safely")
        expect(result.content).toBeUndefined()
        expect(result.file_paths).toBeUndefined()
        expect(readFileSync(outside, "utf8")).toBe("synthetic hardlink target")
    })

    test.skipIf(process.platform !== "win32")("rejects Windows drive-relative paths", async (): Promise<void> => {
        const result = await read("C:INDEX.md")
        expect(result.error).toBe("Glob uses ambiguous drive or UNC path semantics.")
        expect(result.content).toBeUndefined()
        expect(result.file_paths).toBeUndefined()
    })
})
