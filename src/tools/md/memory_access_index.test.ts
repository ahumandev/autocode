import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAutocodeMdReadTool } from "../autocode_md_read"
import { createToolContext } from "../test_context"
import { resetRetryCounts } from "@/utils/tools"

const denyExternal = [{ action: "external_directory", resource: "*", effect: "deny" }] as const
const original = "---\ntitle: Memory\n---\n# Root\n\n## Section\n\nOriginal body\n"
const canary = "---\ntitle: Canary\n---\n# Root\n\n## Section\n\nDo not change\n"

async function execute(tool: ToolDefinition, args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
    const result = await tool.execute(args as never, context)
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function expectDenied(result: Record<string, unknown>): void {
    expect(typeof result.failedAction).toBe("string")
    expect(typeof result.error).toBe("string")
    expect(result.file_paths).toBeUndefined()
}

function fileSymlinksAvailable(): boolean {
    const directory = mkdtempSync(path.join(tmpdir(), "autocode-md-symlink-probe-"))
    try {
        const target = path.join(directory, "target")
        writeFileSync(target, "probe")
        try {
            symlinkSync(target, path.join(directory, "link"), "file")
            return true
        }
        catch (error) {
            if (typeof error === "object" && error !== null && "code" in error
                && ["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(String(error.code))) return false
            throw error
        }
    }
    finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

describe("Markdown memory index and glob regressions", () => {
    let root: string
    let project: string
    let memory: string
    let outside: string
    let context: ToolContext
    let previousConfig: string | undefined

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "autocode-md-memory-index-"))
        project = path.join(root, "project")
        memory = path.join(root, "memory")
        outside = path.join(root, "memory-sibling")
        for (const directory of [project, memory, outside, path.join(root, "config")]) mkdirSync(directory, { recursive: true })
        previousConfig = process.env.OPENCODE_CONFIG_DIR
        process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
        context = Object.assign(createToolContext({ directory: project, worktree: project }), { externalDirectoryPermissions: denyExternal })
        writeFileSync(path.join(memory, "doc.md"), original)
        writeFileSync(path.join(outside, "canary.md"), canary)
    })

    afterEach(() => {
        if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = previousConfig
        resetRetryCounts()
        rmSync(root, { recursive: true, force: true })
    })

    test.each(["absolute", "relative", "default"])("memory agent reads the complete configured %s index literally", async (kind) => {
        const directory = kind === "absolute" ? memory : kind === "relative" ? "custom/memory" : undefined
        const indexRoot = kind === "absolute" ? memory : path.join(project, directory ?? ".opencode/autocode/memory")
        mkdirSync(indexRoot, { recursive: true })
        const index = path.join(indexRoot, "INDEX.md")
        const memoryContext = Object.assign(createToolContext({ directory: project, worktree: project, agent: "query-memory" }), { externalDirectoryPermissions: denyExternal })
        const reader = createAutocodeMdReadTool(directory)
        const contents = [
            `${"前置き🙂\r\n".repeat(5000)}# Index\r\n\r\n## Entry\r\n\r\nLast entry\r\n`,
            "Headingless index\n無題🙂\n",
            "",
            '{"failedAction":"synthetic index text","error":"not a tool error"}',
        ]
        for (const content of contents) {
            writeFileSync(index, content)
            for (const pattern of [index, path.relative(project, index)]) {
                expect(await execute(reader, { file_path_glob: pattern }, memoryContext)).toEqual({ content })
            }
        }
    })

    test("only an unfiltered exact configured index request uses literal output", async () => {
        const index = path.join(memory, "INDEX.md")
        const content = "Preamble\n# Index\n\nIndex body\n"
        writeFileSync(index, content)
        const reader = createAutocodeMdReadTool(memory)
        const memoryContext = Object.assign(createToolContext({ directory: project, worktree: project, agent: "query-memory" }), { externalDirectoryPermissions: denyExternal })
        const outline = [{ anchor: "index", line_of_heading: 2, line_count: 4, index: 0 }]

        expect(await execute(reader, { file_path_glob: index }, memoryContext)).toEqual({ content })
        expect(await execute(reader, { file_path_glob: index }, context)).toEqual({ file_paths: { [index]: outline } })
        expect(await execute(reader, { file_path_glob: index, max_anchors: 2 }, memoryContext)).toEqual({ file_paths: { [index]: outline } })
        expect(await execute(reader, { file_path_glob: index, anchor_regex: "^index$", max_content_chars: 4000 }, memoryContext)).toEqual({
            file_paths: { [index]: [{ ...outline[0], content: "Index body" }] },
        })
        const wildcard = await execute(reader, { file_path_glob: path.join(memory, "INDEX*.md") }, memoryContext)
        expect(wildcard.content).toBeUndefined()
        expect(wildcard.file_paths).toEqual({ [index]: outline })
    })

    test("memory agent retains exact, relative, wildcard, and recursive Markdown reads", async () => {
        const nested = path.join(memory, "nested")
        mkdirSync(nested)
        const first = path.join(memory, "doc.md")
        const second = path.join(nested, "nested.md")
        writeFileSync(second, original.replace("Original body", "Nested body"))
        const memoryContext = Object.assign(createToolContext({ directory: project, worktree: project, agent: "query-memory" }), { externalDirectoryPermissions: denyExternal })
        const reader = createAutocodeMdReadTool(memory)
        for (const [pattern, expected] of [
            [first, [first]],
            [path.relative(project, first), [first]],
            [path.join(memory, "*.md"), [first]],
            [path.relative(project, path.join(memory, "*.md")), [first]],
            [path.join(memory, "**", "*.md"), [first, second]],
        ] as const) {
            const result = await execute(reader, { file_path_glob: pattern, max_content_chars: 4000 }, memoryContext)
            expect(result.failedAction).toBeUndefined()
            expect(Object.keys(result.file_paths as object).sort()).toEqual([...expected].sort())
            expect(JSON.stringify(result.file_paths)).toContain("Original body")
            if (expected.length === 2) expect(JSON.stringify(result.file_paths)).toContain("Nested body")
        }
    })

    test("memory agent denies external and project files and handles missing configured roots", async () => {
        const memoryContext = Object.assign(createToolContext({ directory: project, worktree: project, agent: "query-memory" }), { externalDirectoryPermissions: denyExternal })
        const projectFile = path.join(project, "ordinary.md")
        writeFileSync(projectFile, canary)
        const legacyRoot = path.join(project, ".opencode", "autocode", "memory")
        mkdirSync(legacyRoot, { recursive: true })
        const legacyIndex = path.join(legacyRoot, "INDEX.md")
        writeFileSync(legacyIndex, canary)
        const reader = createAutocodeMdReadTool(memory)
        for (const pattern of [projectFile, legacyIndex, path.join(outside, "canary.md"), `${memory}${path.sep}..${path.sep}memory-sibling${path.sep}canary.md`]) {
            const result = await execute(reader, { file_path_glob: pattern }, memoryContext)
            expectDenied(result)
            expect(result.error).toContain("safely")
            expect(JSON.stringify(result)).not.toContain("Do not change")
        }

        const missing = path.join(root, "missing-memory")
        const missingReader = createAutocodeMdReadTool(missing)
        for (const pattern of [path.join(missing, "INDEX.md"), path.join(missing, "*.md")]) {
            const result = await execute(missingReader, { file_path_glob: pattern }, memoryContext)
            expectDenied(result)
            expect(result.error).toBe(`no files matched glob: ${pattern}`)
        }
        expect(existsSync(missing)).toBe(false)
        expect(readFileSync(projectFile, "utf8")).toBe(canary)
        expect(readFileSync(legacyIndex, "utf8")).toBe(canary)
    })

    test.skipIf(process.platform !== "win32")("memory agent accepts native Windows drive paths and project-relative paths", async () => {
        const index = path.join(memory, "INDEX.md")
        const content = "Windows index\n# Entry\n"
        writeFileSync(index, content)
        const memoryContext = Object.assign(createToolContext({ directory: project, worktree: project, agent: "query-memory" }), { externalDirectoryPermissions: denyExternal })
        const reader = createAutocodeMdReadTool(memory)
        expect(index).toMatch(/^[a-z]:\\/i)
        expect(await execute(reader, { file_path_glob: index.replaceAll("\\", "/") }, memoryContext)).toEqual({ content })
        expect(await execute(reader, { file_path_glob: path.relative(project, index) }, memoryContext)).toEqual({ content })
    })

    test.skipIf(process.platform === "win32")("memory agent rejects foreign Windows drive paths", async () => {
        const memoryContext = Object.assign(createToolContext({ directory: project, worktree: project, agent: "query-memory" }), { externalDirectoryPermissions: denyExternal })
        const result = await execute(createAutocodeMdReadTool(memory), { file_path_glob: "C:\\synthetic\\memory\\INDEX.md" }, memoryContext)
        expectDenied(result)
        expect(result.error).toBe("Glob uses ambiguous drive or UNC path semantics.")
    })

    test("memory agent reads an exact index under a root containing glob metacharacters", async () => {
        const unusual = path.join(root, "memory[synthetic]")
        mkdirSync(unusual)
        const index = path.join(unusual, "INDEX.md")
        const content = "Literal [index] preamble\n# Index\n\n終わり\n"
        writeFileSync(index, content)
        const memoryContext = Object.assign(createToolContext({ directory: project, worktree: project, agent: "query-memory" }), { externalDirectoryPermissions: denyExternal })
        const reader = createAutocodeMdReadTool(unusual)
        expect(await execute(reader, { file_path_glob: index }, memoryContext)).toEqual({ content })
        const ordinary = path.join(unusual, "doc.md")
        writeFileSync(ordinary, original)
        const result = await execute(reader, { file_path_glob: ordinary, max_content_chars: 4000 }, memoryContext)
        expect(result.failedAction).toBeUndefined()
        expect(JSON.stringify(result.file_paths)).toContain("Original body")
    })

    test("reads the project-relative literal index under a root with glob metacharacters", async () => {
        const directory = "memory[synthetic]"
        const unusual = path.join(project, directory)
        mkdirSync(unusual)
        const index = path.join(unusual, "INDEX.md")
        const content = "Synthetic preamble\n# Index\n\nComplete index\n"
        writeFileSync(index, content)
        const memoryContext = Object.assign(createToolContext({ directory: project, worktree: project, agent: "query-memory" }), { externalDirectoryPermissions: denyExternal })
        const reader = createAutocodeMdReadTool(directory)

        expect(await execute(reader, { file_path_glob: index }, memoryContext)).toEqual({ content })
        expect(await execute(reader, { file_path_glob: path.join(directory, "INDEX.md") }, memoryContext)).toEqual({ content })
        expect(readFileSync(index, "utf8")).toBe(content)
    })

    test("relative globs reject a project root containing glob metacharacters", async () => {
        const unusualProject = path.join(root, "project[synthetic]")
        mkdirSync(unusualProject)
        writeFileSync(path.join(unusualProject, "doc.md"), original)
        const unusualContext = Object.assign(createToolContext({ directory: unusualProject, worktree: unusualProject }), { externalDirectoryPermissions: denyExternal })
        const result = await execute(createAutocodeMdReadTool(memory), { file_path_glob: "*.md" }, unusualContext)
        expectDenied(result)
        expect(result.error).toBe("Project directory contains glob metacharacters.")
        expect(JSON.stringify(result)).not.toContain("Original body")
    })

    test.skipIf(!fileSymlinksAvailable())("configured index symlink cannot escape memory", async () => {
        const index = path.join(memory, "INDEX.md")
        symlinkSync(path.join(outside, "canary.md"), index, "file")
        const memoryContext = Object.assign(createToolContext({ directory: project, worktree: project, agent: "query-memory" }), { externalDirectoryPermissions: denyExternal })
        const result = await execute(createAutocodeMdReadTool(memory), { file_path_glob: index }, memoryContext)
        expectDenied(result)
        expect(result.error).toContain("safely")
        expect(JSON.stringify(result)).not.toContain("Do not change")
        expect(readFileSync(path.join(outside, "canary.md"), "utf8")).toBe(canary)
    })
})
