import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAutocodeMdCreateTool } from "../autocode_md_create"
import { createAutocodeMdFrontmatterEditTool } from "../autocode_md_frontmatter_edit"
import { createAutocodeMdFrontmatterReadTool } from "../autocode_md_frontmatter_read"
import { createAutocodeMdH1Tool } from "../autocode_md_h1"
import { createAutocodeMdReadTool } from "../autocode_md_read"
import { createAutocodeMdRemoveTool } from "../autocode_md_remove"
import { createAutocodeMdUpdateTool } from "../autocode_md_update"
import { createTools } from "../index"
import { createToolContext } from "../test_context"
import { effectiveExternalDirectoryAction } from "@/utils/external_directory"
import { resetRetryCounts } from "@/utils/tools"

const denyExternal = [{ action: "external_directory", resource: "*", effect: "deny" }] as const
const original = "---\ntitle: Memory\n---\n# Root\n\n## Section\n\nOriginal body\n"
const canary = "---\ntitle: Canary\n---\n# Root\n\n## Section\n\nDo not change\n"

type MarkdownTools = Record<"read" | "frontmatterRead" | "create" | "update" | "remove" | "h1" | "frontmatterEdit", ToolDefinition>

function markdownTools(directory?: string): MarkdownTools {
    return {
        read: createAutocodeMdReadTool(directory),
        frontmatterRead: createAutocodeMdFrontmatterReadTool(directory),
        create: createAutocodeMdCreateTool(directory),
        update: createAutocodeMdUpdateTool(directory),
        remove: createAutocodeMdRemoveTool(directory),
        h1: createAutocodeMdH1Tool(directory),
        frontmatterEdit: createAutocodeMdFrontmatterEditTool(directory),
    }
}

async function execute(tool: ToolDefinition, args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
    const result = await tool.execute(args as never, context)
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function expectDenied(result: Record<string, unknown>): void {
    expect(typeof result.failedAction).toBe("string")
    expect(typeof result.error).toBe("string")
    expect(result.file_paths).toBeUndefined()
}

function linksAvailable(type: "file" | "junction"): boolean {
    if (type === "junction" && process.platform !== "win32") return false
    const directory = mkdtempSync(path.join(tmpdir(), "autocode-md-symlink-probe-"))
    try {
        const target = path.join(directory, "target")
        if (type === "file") writeFileSync(target, "probe")
        else mkdirSync(target)
        try {
            symlinkSync(target, path.join(directory, "link"), type)
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

describe("Markdown memory authorization integration", () => {
    let root: string
    let project: string
    let memory: string
    let outside: string
    let context: ToolContext
    let previousConfig: string | undefined

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "autocode-md-memory-"))
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

    async function exerciseAll(tools: MarkdownTools, file: string): Promise<void> {
        const read = await execute(tools.read, { file_path_glob: file, max_content_chars: 4000 }, context)
        expect(JSON.stringify(read.file_paths)).toContain("Original body")
        const frontmatter = await execute(tools.frontmatterRead, { file_path_glob: file }, context)
        expect(JSON.stringify(frontmatter.file_paths)).toContain("Memory")

        expect((await execute(tools.create, { file_path: file, heading: "Added", content: "New body" }, context)).file_path).toBe(file)
        expect(readFileSync(file, "utf8")).toContain("New body")
        expect((await execute(tools.update, { file_path: file, anchor: "added", content: "Updated body" }, context)).file_path).toBe(file)
        expect(readFileSync(file, "utf8")).toContain("Updated body")
        expect((await execute(tools.remove, { file_path: file, anchor: "added" }, context)).file_path).toBe(file)
        expect(readFileSync(file, "utf8")).not.toContain("Updated body")
        expect((await execute(tools.h1, { file_path: file, title: "Changed" }, context)).file_path).toBe(file)
        expect(readFileSync(file, "utf8")).toContain("# Changed")
        expect((await execute(tools.frontmatterEdit, { path: file, frontmatter: "title: Edited" }, context)).changed).toBe(true)
        expect(readFileSync(file, "utf8")).toContain("title: Edited")
    }

    async function expectEscapedLinkDenied(file: string): Promise<void> {
        const tools = markdownTools(memory)
        for (const reader of [tools.read, tools.frontmatterRead]) {
            const result = await execute(reader, { file_path_glob: file }, context)
            expectDenied(result)
            expect(result.error).toContain("safely")
        }
        for (const [tool, args] of [
            [tools.create, { file_path: file, heading: "Intrusion" }],
            [tools.update, { file_path: file, anchor: "section", content: "Intrusion" }],
            [tools.remove, { file_path: file, anchor: "section" }],
            [tools.h1, { file_path: file, title: "Intrusion" }],
            [tools.frontmatterEdit, { path: file, frontmatter: "title: Intrusion" }],
        ] as const) {
            const result = await execute(tool, args, context)
            expectDenied(result)
            expect(result.error).toContain("memory directory policy")
        }
        expect(readFileSync(path.join(outside, "canary.md"), "utf8")).toBe(canary)
    }

    async function expectWildcardNoLeak(pattern: string): Promise<void> {
        const tools = markdownTools(memory)
        for (const reader of [tools.read, tools.frontmatterRead]) {
            const result = await execute(reader, { file_path_glob: pattern, max_content_chars: 4000 }, context)
            if (result.failedAction !== undefined) expect(result.error).toContain("safely")
            else expect(JSON.stringify(result.file_paths)).toContain("doc.md")
            expect(JSON.stringify(result.file_paths ?? {})).not.toContain("Do not change")
            expect(JSON.stringify(result.file_paths ?? {})).not.toContain("Canary")
        }
    }

    test("all seven factories bypass a matching deny only for configured external memory", async () => {
        const target = path.join(memory, "doc.md")
        expect(effectiveExternalDirectoryAction([], denyExternal, target)).toBe("deny")
        expect(effectiveExternalDirectoryAction([], denyExternal, path.join(outside, "canary.md"))).toBe("deny")
        await exerciseAll(markdownTools(memory), target)
    })

    test("createTools injects memory configuration into all seven tools", async () => {
        const tools = createTools({} as OpencodeClient, {}, undefined, { isWindows: true }, { directory: memory })
        await exerciseAll({
            read: tools.autocode_md_read,
            frontmatterRead: tools.autocode_md_frontmatter_read,
            create: tools.autocode_md_create,
            update: tools.autocode_md_update,
            remove: tools.autocode_md_remove,
            h1: tools.autocode_md_h1,
            frontmatterEdit: tools.autocode_md_frontmatter_edit,
        }, path.join(memory, "doc.md"))
    })

    test.each([undefined, "custom/memories", "../memory"])("all tools access default or relative memory root %s", async (directory) => {
        const localMemory = path.join(project, directory ?? ".opencode/autocode/memory")
        mkdirSync(localMemory, { recursive: true })
        const file = path.join(localMemory, "doc.md")
        writeFileSync(file, original)
        await exerciseAll(markdownTools(directory), file)
    })

    test.each([undefined, ".opencode/autocode/memory"])("learn-memory bootstraps first default index with configuration %s", async (directory) => {
        const file = path.join(project, ".opencode", "autocode", "memory", "INDEX.md")
        const memoryContext = { ...context, agent: "learn-memory" }
        const result = await execute(markdownTools(directory).create, { file_path: file, heading: "First", content: "Useful memory" }, memoryContext)
        expect(result.file_path).toBe(file)
        expect(readFileSync(file, "utf8")).toContain("Useful memory")
    })

    test.each([".opencode", ".opencode/autocode"])("bootstrap creates missing memory root under existing %s only for valid input", async (parent) => {
        mkdirSync(path.join(project, parent), { recursive: true })
        const file = path.join(project, ".opencode", "autocode", "memory", "INDEX.md")
        const memoryContext = { ...context, agent: "learn-memory" }
        expectDenied(await execute(markdownTools().create, { file_path: file, heading: "" }, memoryContext))
        expect(existsSync(path.dirname(file))).toBe(false)
        if (parent === ".opencode") expect(existsSync(path.join(project, ".opencode", "autocode"))).toBe(false)
        const result = await execute(markdownTools().create, { file_path: file, heading: "First" }, memoryContext)
        expect(result.file_path).toBe(file)
        expect(readFileSync(file, "utf8")).toContain("First")
    })

    test("bootstrap does not create parents for other paths, agents, or configured roots", async () => {
        const memoryContext = { ...context, agent: "learn-memory" }
        const defaultRoot = path.join(project, ".opencode", "autocode", "memory")
        const externalRoot = path.join(root, "missing-external")
        const cases = [
            { directory: undefined, file: path.join(defaultRoot, "other.md"), context: memoryContext },
            { directory: undefined, file: path.join(defaultRoot, "nested", "INDEX.md"), context: memoryContext },
            { directory: undefined, file: path.join(defaultRoot, "INDEX.md"), context },
            { directory: path.join(project, ".opencode", "autocode", "memory"), file: path.join(defaultRoot, "INDEX.md"), context: memoryContext },
            { directory: ".opencode/memory", file: path.join(project, ".opencode", "memory", "INDEX.md"), context: memoryContext },
            { directory: externalRoot, file: path.join(externalRoot, "INDEX.md"), context: memoryContext },
            { directory: undefined, file: path.join(project, "outside.md"), context: memoryContext },
        ]
        for (const entry of cases) {
            const result = await execute(markdownTools(entry.directory).create, { file_path: entry.file, heading: "First" }, entry.context)
            expectDenied(result)
        }
        expect(existsSync(path.join(project, ".opencode"))).toBe(false)
        expect(existsSync(externalRoot)).toBe(false)
        expect(existsSync(path.join(project, "outside.md"))).toBe(false)
    })

    test("learn-memory writes configured external index only when its root exists", async () => {
        const file = path.join(memory, "INDEX.md")
        const result = await execute(markdownTools(memory).create, { file_path: file, heading: "First", content: "External memory" }, { ...context, agent: "learn-memory" })
        expect(result.file_path).toBe(file)
        expect(readFileSync(file, "utf8")).toContain("External memory")
    })

    test("learn-memory writes a distinct configured index after its root is provisioned", async () => {
        const directory = ".opencode/memory"
        const localRoot = path.join(project, directory)
        mkdirSync(localRoot, { recursive: true })
        const file = path.join(localRoot, "INDEX.md")
        const result = await execute(markdownTools(directory).create, { file_path: file, heading: "First" }, { ...context, agent: "learn-memory" })
        expect(result.file_path).toBe(file)
        expect(readFileSync(file, "utf8")).toContain("First")
        expect(existsSync(path.join(project, ".opencode", "autocode", "memory"))).toBe(false)
    })

    for (const linked of [".opencode", ".opencode/autocode"]) {
        test.skipIf(process.platform === "win32" ? !linksAvailable("junction") : !linksAvailable("file"))(`bootstrap refuses a ${linked} link outside the project`, async () => {
            const link = path.join(project, linked)
            mkdirSync(path.dirname(link), { recursive: true })
            symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
            const file = path.join(project, ".opencode", "autocode", "memory", "INDEX.md")
            const result = await execute(markdownTools().create, { file_path: file, heading: "First" }, { ...context, agent: "learn-memory" })
            expectDenied(result)
            expect(existsSync(path.join(outside, "memory"))).toBe(false)
            expect(existsSync(path.join(outside, "autocode"))).toBe(false)
            expect(readFileSync(path.join(outside, "canary.md"), "utf8")).toBe(canary)
        })
    }

    test("all seven reject ordinary external and sibling-prefix paths without changing disk", async () => {
        const tools = markdownTools(memory)
        const unrelated = path.join(root, "other.md")
        writeFileSync(unrelated, canary)
        for (const file of [unrelated, path.join(outside, "canary.md")]) {
            expect(effectiveExternalDirectoryAction([], denyExternal, file)).toBe("deny")
            for (const reader of [tools.read, tools.frontmatterRead]) {
                const result = await execute(reader, { file_path_glob: file }, context)
                expectDenied(result)
                expect(result.error).toContain("external_directory")
            }
            for (const [tool, args] of [
                [tools.create, { file_path: file, heading: "Intrusion" }],
                [tools.update, { file_path: file, anchor: "section", content: "Intrusion" }],
                [tools.remove, { file_path: file, anchor: "section" }],
                [tools.h1, { file_path: file, title: "Intrusion" }],
                [tools.frontmatterEdit, { path: file, frontmatter: "title: Intrusion" }],
            ] as const) {
                const result = await execute(tool, args, context)
                expectDenied(result)
                expect(result.error).toContain("external_directory")
            }
            expect(readFileSync(file, "utf8")).toBe(canary)
        }
    })

    test("readers handle literal, wildcard and recursive memory paths while denying external scan bases", async () => {
        const nested = path.join(memory, "nested")
        mkdirSync(nested)
        writeFileSync(path.join(nested, "nested.md"), original.replace("Memory", "Nested"))
        const tools = markdownTools(memory)
        for (const reader of [tools.read, tools.frontmatterRead]) {
            for (const pattern of [path.join(memory, "doc.md"), path.relative(project, path.join(memory, "doc.md")), path.join(memory, "*.md"), path.relative(project, path.join(memory, "*.md")), path.join(memory, "**", "*.md")]) {
                const result = await execute(reader, { file_path_glob: pattern, max_content_chars: 4000 }, context)
                expect(result.failedAction).toBeUndefined()
                expect(JSON.stringify(result.file_paths)).toContain("doc.md")
                if (pattern.includes("**")) expect(JSON.stringify(result.file_paths)).toContain("nested.md")
            }
            for (const pattern of [path.join(root, "memory*", "*.md"), path.join(root, "{memory,memory-sibling}", "*.md"), path.join(outside, "*.md")]) {
                const result = await execute(reader, { file_path_glob: pattern }, context)
                expectDenied(result)
                expect(JSON.stringify(result)).not.toContain("Do not change")
            }
        }
    })

    test("traversal and ambiguous patterns cannot read or write outside memory", async () => {
        const tools = markdownTools(memory)
        const escaped = `${memory}${path.sep}..${path.sep}memory-sibling${path.sep}canary.md`
        for (const reader of [tools.read, tools.frontmatterRead]) {
            for (const pattern of [escaped, `!${path.join(memory, "*.md")}`, `${memory}${path.sep}*${path.sep}..${path.sep}*.md`]) {
                expectDenied(await execute(reader, { file_path_glob: pattern }, context))
            }
        }
        expectDenied(await execute(tools.read, { file_path_glob: path.join(memory, "doc.md"), anchor_regex: "[" }, context))
        expectDenied(await execute(tools.frontmatterRead, { file_path_glob: path.join(memory, "doc.md"), key_regex: "[" }, context))
        expectDenied(await execute(tools.h1, { file_path: escaped, title: "Intrusion" }, context))
        expectDenied(await execute(tools.frontmatterEdit, { path: escaped, frontmatter: "title: Intrusion" }, context))
        expect(readFileSync(path.join(outside, "canary.md"), "utf8")).toBe(canary)
    })

    test.skipIf(!linksAvailable("junction"))("Windows junction nested in memory cannot escape", async () => {
        const nested = path.join(memory, "nested")
        const junction = path.join(nested, "escape")
        mkdirSync(nested)
        symlinkSync(outside, junction, "junction")
        expect(lstatSync(junction).isSymbolicLink()).toBe(true)
        expect(realpathSync(junction).toLowerCase()).toBe(realpathSync(outside).toLowerCase())
        await expectEscapedLinkDenied(path.join(junction, "canary.md"))
        const tools = markdownTools(memory)
        for (const reader of [tools.read, tools.frontmatterRead]) {
            const result = await execute(reader, { file_path_glob: path.join(junction, "*.md"), max_content_chars: 4000 }, context)
            expectDenied(result)
            expect(result.error).toContain("safely")
            expect(JSON.stringify(result)).not.toContain("Do not change")
            expect(JSON.stringify(result)).not.toContain("Canary")
        }
        await expectWildcardNoLeak(path.join(memory, "**", "*.md"))
        expect(readFileSync(path.join(outside, "canary.md"), "utf8")).toBe(canary)
    })

    test.skipIf(!linksAvailable("file"))("file symlink inside memory cannot escape", async () => {
        const link = path.join(memory, "linked.md")
        symlinkSync(path.join(outside, "canary.md"), link, "file")
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        await expectEscapedLinkDenied(link)
        await expectWildcardNoLeak(path.join(memory, "*.md"))
        expect(readFileSync(path.join(outside, "canary.md"), "utf8")).toBe(canary)
    })

    test.skipIf(process.platform === "win32" || !linksAvailable("file"))("links inside memory cannot escape through files, nested directories, or dangling targets", async () => {
        const tools = markdownTools(memory)
        mkdirSync(path.join(memory, "nested"))
        symlinkSync(outside, path.join(memory, "nested", "escape"), "dir")
        symlinkSync(path.join(outside, "canary.md"), path.join(memory, "linked.md"), "file")
        symlinkSync(path.join(outside, "missing.md"), path.join(memory, "dangling.md"), "file")
        for (const file of [path.join(memory, "linked.md"), path.join(memory, "nested", "escape", "canary.md"), path.join(memory, "dangling.md")]) {
            for (const reader of [tools.read, tools.frontmatterRead]) {
                const result = await execute(reader, { file_path_glob: file }, context)
                expectDenied(result)
                expect(result.error).toContain("safely")
            }
            for (const [tool, args] of [
                [tools.create, { file_path: file, heading: "Intrusion" }],
                [tools.update, { file_path: file, anchor: "section", content: "Intrusion" }],
                [tools.remove, { file_path: file, anchor: "section" }],
                [tools.h1, { file_path: file, title: "Intrusion" }],
                [tools.frontmatterEdit, { path: file, frontmatter: "title: Intrusion" }],
            ] as const) {
                const result = await execute(tool, args, context)
                expectDenied(result)
                expect(result.error).toContain("memory directory policy")
            }
        }
        for (const reader of [tools.read, tools.frontmatterRead]) {
            const result = await execute(reader, { file_path_glob: path.join(memory, "*.md"), max_content_chars: 4000 }, context)
            if (result.failedAction !== undefined) expect(result.error).toContain("safely")
            else expect(JSON.stringify(result.file_paths)).toContain("doc.md")
            expect(JSON.stringify(result.file_paths ?? {})).not.toContain("Do not change")
            expect(JSON.stringify(result.file_paths ?? {})).not.toContain("Canary")
        }
        expect(readFileSync(path.join(outside, "canary.md"), "utf8")).toBe(canary)
        expect(existsSync(path.join(outside, "missing.md"))).toBe(false)
    })

    test.skipIf(process.platform === "win32" || !linksAvailable("file"))("default and relative memory roots reject links escaping the project", async () => {
        for (const directory of [undefined, "custom/memories"]) {
            const localMemory = path.join(project, directory ?? ".opencode/autocode/memory")
            mkdirSync(localMemory, { recursive: true })
            const link = path.join(localMemory, "linked.md")
            symlinkSync(path.join(outside, "canary.md"), link, "file")
            const tools = markdownTools(directory)
            for (const reader of [tools.read, tools.frontmatterRead]) {
                const result = await execute(reader, { file_path_glob: link }, context)
                expectDenied(result)
                expect(result.error).toContain("safely")
            }
            const result = await execute(tools.h1, { file_path: link, title: "Intrusion" }, context)
            expectDenied(result)
            expect(result.error).toContain("memory directory policy")
        }
        expect(readFileSync(path.join(outside, "canary.md"), "utf8")).toBe(canary)
    })
})
