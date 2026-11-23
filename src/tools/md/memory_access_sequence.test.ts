import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Glob } from "bun"
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import * as glob from "@/utils/glob"
import { effectiveExternalDirectoryAction } from "@/utils/external_directory"
import { resetRetryCounts } from "@/utils/tools"
import { createToolContext } from "../test_context"

const denyExternal = [{ action: "external_directory", resource: "*", effect: "deny" }] as const
const originalExpandGlob = glob.expandGlob
const document = "---\ntitle: Memory\n---\n# Root\n\nBody\n"

async function execute(tool: ToolDefinition, pattern: string, context: ToolContext): Promise<Record<string, unknown>> {
    const result = await tool.execute({ file_path_glob: pattern, max_content_chars: 4000 } as never, context)
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function expectDenied(result: Record<string, unknown>, error: string): void {
    expect(typeof result.failedAction).toBe("string")
    expect(result.error).toEqual(expect.stringContaining(error))
    expect(result.file_paths).toBeUndefined()
}

function junctionsAvailable(): boolean {
    if (process.platform !== "win32") return false
    const directory = fs.mkdtempSync(path.join(tmpdir(), "autocode-md-junction-probe-"))
    try {
        const target = path.join(directory, "target")
        fs.mkdirSync(target)
        try {
            fs.symlinkSync(target, path.join(directory, "junction"), "junction")
            return true
        }
        catch (error) {
            if (typeof error === "object" && error !== null && "code" in error
                && ["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(String(error.code))) return false
            throw error
        }
    }
    finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
}

const skipJunction = !junctionsAvailable()

describe("Markdown glob authorization sequence", () => {
    let expandSpy: ReturnType<typeof spyOn<typeof glob, "expandGlob">>
    let scanSpy: ReturnType<typeof spyOn<typeof Glob.prototype, "scan">>
    let syncReadSpy: ReturnType<typeof spyOn<typeof fs, "readFileSync">>
    let asyncReadSpy: ReturnType<typeof spyOn<typeof fsPromises, "readFile">>
    let createRead: typeof import("../autocode_md_read").createAutocodeMdReadTool
    let createFrontmatterRead: typeof import("../autocode_md_frontmatter_read").createAutocodeMdFrontmatterReadTool
    let root: string
    let project: string
    let memory: string
    let outside: string
    let allowed: string
    let context: ToolContext
    let previousConfig: string | undefined

    beforeAll(async () => {
        expandSpy = spyOn(glob, "expandGlob")
        scanSpy = spyOn(Glob.prototype, "scan")
        syncReadSpy = spyOn(fs, "readFileSync")
        asyncReadSpy = spyOn(fsPromises, "readFile")
        ;({ createAutocodeMdReadTool: createRead } = await import("../autocode_md_read"))
        ;({ createAutocodeMdFrontmatterReadTool: createFrontmatterRead } = await import("../autocode_md_frontmatter_read"))
    })

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(tmpdir(), "autocode-md-sequence-"))
        project = path.join(root, "project")
        memory = path.join(root, "memory")
        outside = path.join(root, "outside")
        for (const directory of [project, memory, outside, path.join(root, "config")]) fs.mkdirSync(directory, { recursive: true })
        allowed = path.join(memory, "allowed.md")
        fs.writeFileSync(allowed, document)
        fs.writeFileSync(path.join(outside, "canary.md"), document.replace("Memory", "Canary"))
        previousConfig = process.env.OPENCODE_CONFIG_DIR
        process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
        context = Object.assign(createToolContext({ directory: project, worktree: project }), { externalDirectoryPermissions: denyExternal })
        expandSpy.mockImplementation(originalExpandGlob)
        expandSpy.mockClear()
        scanSpy.mockClear()
        syncReadSpy.mockClear()
        asyncReadSpy.mockClear()
    })

    afterEach(() => {
        if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = previousConfig
        resetRetryCounts()
        fs.rmSync(root, { recursive: true, force: true })
    })

    afterAll(() => {
        mock.restore()
    })

    test("external scan bases are denied before expansion or scanning", async () => {
        expect(effectiveExternalDirectoryAction([], denyExternal, outside)).toBe("deny")
        for (const reader of [createRead(memory), createFrontmatterRead(memory)]) {
            expectDenied(await execute(reader, path.join(outside, "*.md"), context), "external_directory")
        }
        expect(expandSpy).toHaveBeenCalledTimes(0)
        expect(scanSpy).toHaveBeenCalledTimes(0)
    })

    test("query-memory validates every expanded match before reading any file", async () => {
        const memoryContext = Object.assign(createToolContext({ directory: project, worktree: project, agent: "query-memory" }), { externalDirectoryPermissions: denyExternal })
        const escaped = path.join(outside, "canary.md")
        const pattern = path.join(memory, "*.md")
        for (const reader of [createRead(memory), createFrontmatterRead(memory)]) {
            expandSpy.mockClear()
            syncReadSpy.mockClear()
            asyncReadSpy.mockClear()
            expandSpy.mockResolvedValue([{ key: allowed, absolute: allowed }, { key: escaped, absolute: escaped }])
            expectDenied(await execute(reader, pattern, memoryContext), "safely")
            expect(expandSpy).toHaveBeenCalledTimes(1)
            expect(syncReadSpy.mock.calls.filter(([file]) => file === allowed || file === escaped)).toHaveLength(0)
            expect(asyncReadSpy.mock.calls.filter(([file]) => file === allowed || file === escaped)).toHaveLength(0)
        }
    })

    test("each exact index invocation expands and reads the index once", async () => {
        const index = path.join(memory, "INDEX.md")
        const content = "Preamble\n# Index\n\nComplete index\n"
        fs.writeFileSync(index, content)
        const memoryContext = Object.assign(createToolContext({ directory: project, worktree: project, agent: "query-memory" }), { externalDirectoryPermissions: denyExternal })
        const reader = createRead(memory)
        for (let invocation = 1; invocation <= 2; invocation++) {
            const result = await reader.execute({ file_path_glob: index } as never, memoryContext)
            expect(JSON.parse(typeof result === "string" ? result : result.output)).toEqual({ content })
            expect(expandSpy).toHaveBeenCalledTimes(invocation)
            expect(syncReadSpy.mock.calls.filter(([file]) => file === index)).toHaveLength(invocation)
        }
    })

    test.skipIf(skipJunction)("junction scan bases are denied before expansion or scanning", async () => {
        const junction = path.join(memory, "escape")
        fs.symlinkSync(outside, junction, "junction")
        expect(fs.lstatSync(junction).isSymbolicLink()).toBe(true)
        expect(fs.realpathSync(junction).toLowerCase()).toBe(fs.realpathSync(outside).toLowerCase())
        for (const reader of [createRead(memory), createFrontmatterRead(memory)]) {
            expectDenied(await execute(reader, path.join(junction, "*.md"), context), "safely")
        }
        expect(expandSpy).toHaveBeenCalledTimes(0)
        expect(scanSpy).toHaveBeenCalledTimes(0)
    })

    test.skipIf(skipJunction)("both readers authorize every match before reading either target", async () => {
        const junction = path.join(memory, "escape")
        fs.symlinkSync(outside, junction, "junction")
        const escaped = path.join(junction, "canary.md")
        const pattern = path.join(memory, "*.md")
        const first = { key: allowed, absolute: allowed }
        const second = { key: escaped, absolute: escaped }
        expect(fs.realpathSync(junction).toLowerCase()).toBe(fs.realpathSync(outside).toLowerCase())

        for (const [reader, mode] of [[createRead(memory), "sync"], [createFrontmatterRead(memory), "async"]] as const) {
            expandSpy.mockClear()
            syncReadSpy.mockClear()
            asyncReadSpy.mockClear()
            expandSpy.mockResolvedValue([first])
            const control = await execute(reader, pattern, context)
            expect(control.failedAction).toBeUndefined()
            expect(Object.keys(control.file_paths as object)).toEqual([allowed])
            expect(expandSpy).toHaveBeenCalledTimes(1)
            const syncReads = syncReadSpy.mock.calls.filter(([file]) => file === allowed)
            const asyncReads = asyncReadSpy.mock.calls.filter(([file]) => file === allowed)
            expect(syncReads).toHaveLength(mode === "sync" ? 1 : 0)
            expect(asyncReads).toHaveLength(mode === "async" ? 1 : 0)

            expandSpy.mockClear()
            syncReadSpy.mockClear()
            asyncReadSpy.mockClear()
            expandSpy.mockResolvedValue([first, second])
            expectDenied(await execute(reader, pattern, context), "safely")
            expect(expandSpy).toHaveBeenCalledTimes(1)
            expect(expandSpy.mock.calls[0][0]).toBe(pattern)
            expect(syncReadSpy.mock.calls.filter(([file]) => file === allowed || file === escaped)).toHaveLength(0)
            expect(asyncReadSpy.mock.calls.filter(([file]) => file === allowed || file === escaped)).toHaveLength(0)
        }
    })

    test.skipIf(skipJunction)("recursive memory scans disable symlink following and exclude junction descendants", async () => {
        const junction = path.join(memory, "escape")
        fs.symlinkSync(outside, junction, "junction")
        expect(fs.lstatSync(junction).isSymbolicLink()).toBe(true)
        expect(fs.realpathSync(junction).toLowerCase()).toBe(fs.realpathSync(outside).toLowerCase())
        const pattern = path.join(memory, "**", "*.md")
        const result = await execute(createRead(memory), pattern, context)
        expect(result.failedAction).toBeUndefined()
        expect(Object.keys(result.file_paths as object)).toEqual([allowed])
        expect(expandSpy).toHaveBeenCalledTimes(1)
        expect(scanSpy).toHaveBeenCalledTimes(1)
        expect(scanSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ cwd: memory, followSymlinks: false }))
    })
})
