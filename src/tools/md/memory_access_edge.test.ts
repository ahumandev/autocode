import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAutocodeMdCreateTool } from "../autocode_md_create"
import { createAutocodeMdFrontmatterEditTool } from "../autocode_md_frontmatter_edit"
import { createAutocodeMdFrontmatterReadTool } from "../autocode_md_frontmatter_read"
import { createAutocodeMdH1Tool } from "../autocode_md_h1"
import { createAutocodeMdReadTool } from "../autocode_md_read"
import { createAutocodeMdRemoveTool } from "../autocode_md_remove"
import { createAutocodeMdUpdateTool } from "../autocode_md_update"
import { createToolContext } from "../test_context"
import { effectiveExternalDirectoryAction } from "@/utils/external_directory"
import { resetRetryCounts } from "@/utils/tools"

const denyExternal = [{ action: "external_directory", resource: "*", effect: "deny" }] as const
const canary = "---\ntitle: Canary\n---\n# Canary\n\nKeep unchanged\n"

async function execute(tool: ToolDefinition, args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
    const result = await tool.execute(args as never, context)
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function expectDenied(result: Record<string, unknown>, message: string): void {
    expect(typeof result.failedAction).toBe("string")
    expect(result.error).toContain(message)
    expect(result.file_paths).toBeUndefined()
    expect(result.file_path).toBeUndefined()
}

function junctionSkipReason(): string | undefined {
    if (process.platform !== "win32") return "requires native Windows junctions"
    const root = mkdtempSync(path.join(tmpdir(), "autocode-md-junction-probe-"))
    const target = path.join(root, "target")
    const junction = path.join(root, "junction")
    try {
        mkdirSync(target)
        try {
            symlinkSync(target, junction, "junction")
        }
        catch (error) {
            if (typeof error === "object" && error !== null && "code" in error
                && ["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(String(error.code))) {
                return `junction creation unavailable: ${String(error.code)}`
            }
            throw error
        }
        return undefined
    }
    finally {
        if (existsSync(junction)) unlinkSync(junction)
        rmSync(root, { recursive: true, force: true })
    }
}

const skipJunction = junctionSkipReason()

describe("Markdown memory access edge cases", () => {
    let root: string
    let project: string
    let memory: string
    let outside: string
    let context: ToolContext
    let previousConfig: string | undefined

    beforeEach((): void => {
        root = realpathSync(mkdtempSync(path.join(tmpdir(), "autocode-md-edge-")))
        project = path.join(root, "project")
        memory = path.join(root, "memory")
        outside = path.join(root, "outside")
        for (const directory of [project, outside, path.join(root, "config")]) mkdirSync(directory)
        previousConfig = process.env.OPENCODE_CONFIG_DIR
        process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
        context = Object.assign(createToolContext({ directory: project, worktree: project }), { externalDirectoryPermissions: denyExternal })
    })

    afterEach((): void => {
        if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = previousConfig
        resetRetryCounts()
        rmSync(root, { recursive: true, force: true })
    })

    test("create does not create a missing external memory root, but succeeds once provisioned despite deny", async (): Promise<void> => {
        const file = path.join(memory, "entry.md")
        const args = { file_path: file, heading: "Entry", content: "Memory body" }
        const create = createAutocodeMdCreateTool(memory)
        expect(path.isAbsolute(memory)).toBe(true)
        expect(effectiveExternalDirectoryAction([], denyExternal, file)).toBe("deny")
        expect(existsSync(memory)).toBe(false)

        const failed = await execute(create, args, context)
        expect(failed.failedAction).toBe("autocode_md_create")
        expect(failed.error).toContain("ENOENT")
        expect(failed.file_path).toBeUndefined()
        expect(existsSync(memory)).toBe(false)

        mkdirSync(memory)
        const created = await execute(create, args, context)
        expect(created.failedAction).toBeUndefined()
        expect(created.file_path).toBe(file)
        expect(created.outline).toEqual({ entry: {} })
        expect(readFileSync(file, "utf8")).toBe("## Entry\n\nMemory body\n")
    })

    test.skipIf(skipJunction !== undefined)(`escaped and dangling junctions deny reads and writes${skipJunction ? ` (skipped: ${skipJunction})` : ""}`, async (): Promise<void> => {
        mkdirSync(memory)
        const target = path.join(outside, "target")
        const junction = path.join(memory, "escape")
        const outsideCanary = path.join(outside, "canary.md")
        const targetCanary = path.join(target, "canary.md")
        mkdirSync(target)
        writeFileSync(outsideCanary, canary)
        writeFileSync(targetCanary, canary)
        symlinkSync(target, junction, "junction")
        try {
            expect(lstatSync(junction).isSymbolicLink()).toBe(true)
            expect(realpathSync(junction).toLowerCase()).toBe(realpathSync(target).toLowerCase())
            const file = path.join(junction, "canary.md")
            const readers = [createAutocodeMdReadTool(memory), createAutocodeMdFrontmatterReadTool(memory)]
            const writers = [
                [createAutocodeMdCreateTool(memory), { file_path: file, heading: "Intrusion" }],
                [createAutocodeMdUpdateTool(memory), { file_path: file, anchor: "canary", content: "Intrusion" }],
                [createAutocodeMdRemoveTool(memory), { file_path: file, anchor: "canary" }],
                [createAutocodeMdH1Tool(memory), { file_path: file, title: "Intrusion" }],
                [createAutocodeMdFrontmatterEditTool(memory), { path: file, frontmatter: "title: Intrusion" }],
            ] as const

            for (const state of ["escaped", "dangling"]) {
                if (state === "dangling") {
                    rmSync(target, { recursive: true })
                    expect(lstatSync(junction).isSymbolicLink()).toBe(true)
                    expect(existsSync(target)).toBe(false)
                }
                for (const reader of readers) {
                    const result = await execute(reader, { file_path_glob: file }, context)
                    expectDenied(result, "safely")
                    expect(JSON.stringify(result)).not.toContain("Keep unchanged")
                }
                for (const [tool, args] of writers) expectDenied(await execute(tool, args, context), "memory directory policy")
                expect(readFileSync(outsideCanary, "utf8")).toBe(canary)
                if (state === "escaped") expect(readFileSync(targetCanary, "utf8")).toBe(canary)
                else expect(existsSync(target)).toBe(false)
            }
        }
        finally {
            unlinkSync(junction)
        }
    })

    test("scoped external allow permits ordinary create and frontmatter read and edit", async (): Promise<void> => {
        mkdirSync(memory)
        const file = path.join(outside, "allowed.md")
        const permissions = [
            ...denyExternal,
            { action: "external_directory", resource: `${outside}${path.sep}*`, effect: "allow" },
        ] as const
        const allowedContext = Object.assign(createToolContext({
            directory: project,
            worktree: project,
            ask: async (): Promise<void> => { throw new Error("unexpected permission prompt") },
        }), { externalDirectoryPermissions: permissions })
        expect(effectiveExternalDirectoryAction([], permissions, file)).toBe("allow")
        expect(effectiveExternalDirectoryAction([], permissions, path.join(root, "other.md"))).toBe("deny")

        const created = await execute(createAutocodeMdCreateTool(memory), { file_path: file, heading: "External", content: "External body" }, allowedContext)
        expect(created.failedAction).toBeUndefined()
        expect(created.file_path).toBe(file)
        expect(readFileSync(file, "utf8")).toBe("## External\n\nExternal body\n")

        const edit = createAutocodeMdFrontmatterEditTool(memory)
        const edited = await execute(edit, { path: file, frontmatter: "title: Allowed" }, allowedContext)
        expect(edited).toEqual({ path: file, hasFrontmatter: true, changed: true, truncated: false })
        expect(readFileSync(file, "utf8")).toBe("---\ntitle: Allowed\n---\n\n## External\n\nExternal body\n")

        const read = await execute(createAutocodeMdFrontmatterReadTool(memory), { file_path_glob: file }, allowedContext)
        expect(read.failedAction).toBeUndefined()
        expect(read.file_paths).toEqual({ [file]: { key_paths: { title: "Allowed" }, nodes_shown: 1, nodes_total: 1 } })

        const updated = await execute(edit, { path: file, frontmatter: "title: Updated" }, allowedContext)
        expect(updated).toEqual({ path: file, hasFrontmatter: true, changed: true, truncated: false })
        expect(readFileSync(file, "utf8")).toBe("---\ntitle: Updated\n---\n\n## External\n\nExternal body\n")
    })
})
