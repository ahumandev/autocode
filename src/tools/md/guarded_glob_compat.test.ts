import { Glob } from "bun"
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expandGlob } from "@/utils/glob"
import { resetRetryCounts } from "@/utils/tools"
import { createToolContext } from "../test_context"
import { expandAuthorizedMarkdownGlob } from "./guarded_glob"

const denyExternal = [{ action: "external_directory", resource: "*", effect: "deny" }] as const
const secret = "outside-canary-secret"

function linkSkipReason(): string | undefined {
    const root = mkdtempSync(path.join(tmpdir(), "autocode-glob-link-probe-"))
    try {
        const target = path.join(root, "target")
        mkdirSync(target)
        try {
            symlinkSync(target, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir")
        }
        catch (error) {
            if (typeof error === "object" && error !== null && "code" in error
                && ["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(String(error.code))) {
                return `link creation unavailable: ${String(error.code)}`
            }
            throw error
        }
        return undefined
    }
    finally {
        rmSync(root, { recursive: true, force: true })
    }
}

const skipLink = linkSkipReason()

describe("guarded Markdown glob compatibility", () => {
    let root: string
    let project: string
    let outside: string
    let memory: string
    let context: ToolContext
    let previousConfig: string | undefined

    beforeEach((): void => {
        root = realpathSync(mkdtempSync(path.join(tmpdir(), "autocode-glob-compat-")))
        project = path.join(root, "project")
        outside = path.join(root, "outside")
        memory = path.join(root, "memory")
        for (const directory of [path.join(project, "docs", "a"), outside, memory, path.join(root, "config")]) {
            mkdirSync(directory, { recursive: true })
        }
        for (const file of ["draft.md", "!draft.md", "note!.md", "docs/draft.md", "docs/other.md", "docs/note.md", "docs/bang!name.md"]) {
            writeFileSync(path.join(project, file), `fixture: ${file}`)
        }
        writeFileSync(path.join(outside, "secret.md"), secret)
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

    async function expectCompatible(pattern: string): Promise<void> {
        const prior = await expandGlob(pattern, project, { dot: true, followSymlinks: false })
        const priorKeys = prior.map((match) => match.key)
        const guarded = await expandAuthorizedMarkdownGlob(pattern, context, "glob compatibility", memory)
        if (priorKeys.length === 0) throw new Error(`Original glob ${pattern} returned no matches: ${JSON.stringify(priorKeys)}`)
        if (!guarded.ok) throw new Error(`Guarded glob ${pattern} rejected; prior matches: ${JSON.stringify(priorKeys)}; response: ${guarded.response}`)
        expect(guarded.matches.map((match) => match.key)).toEqual(priorKeys)
    }

    test.each(["!draft.md", "docs/!(draft).md", "docs/[a]/../note.md"])("preserves original matches for %s", async (pattern): Promise<void> => {
        await expectCompatible(pattern)
    })

    test("preserves literal exclamation and ordinary wildcard matches", async (): Promise<void> => {
        await expectCompatible("docs/bang!name.md")
        await expectCompatible("docs/*.md")
    })

    test.each([
        "**/../../outside/**/*.md",
        "{docs,../outside}/**/*.md",
        "!../outside/**/*.md",
    ])("rejects traversal before scanning: %s", async (pattern): Promise<void> => {
        const scan = spyOn(Glob.prototype, "scan")
        try {
            const result = await expandAuthorizedMarkdownGlob(pattern, context, "glob security", memory)
            expect(result.ok).toBe(false)
            expect(JSON.stringify(result)).not.toContain(secret)
            expect(scan).not.toHaveBeenCalled()
            expect(readFileSync(path.join(outside, "secret.md"), "utf8")).toBe(secret)
        }
        finally {
            scan.mockRestore()
        }
    })

    test("denies external scan base before scanning", async (): Promise<void> => {
        const scan = spyOn(Glob.prototype, "scan")
        try {
            const result = await expandAuthorizedMarkdownGlob(path.join(outside, "*.md"), context, "glob security", memory)
            expect(result.ok).toBe(false)
            if (!result.ok) expect(result.response).toContain("external_directory")
            expect(JSON.stringify(result)).not.toContain(secret)
            expect(scan).not.toHaveBeenCalled()
        }
        finally {
            scan.mockRestore()
        }
    })

    test.each(["query-memory", "learn-memory"])("%s scans configured memory but rejects project paths", async (agent): Promise<void> => {
        const index = path.join(memory, "INDEX.md")
        writeFileSync(index, "# Index")
        const memoryContext = { ...context, agent }
        const allowed = await expandAuthorizedMarkdownGlob(path.join(memory, "*.md"), memoryContext, "glob security", memory)
        expect(allowed.ok).toBe(true)
        if (allowed.ok) expect(allowed.matches.map((match) => match.absolute)).toEqual([index])
        const denied = await expandAuthorizedMarkdownGlob(path.join(project, "*.md"), memoryContext, "glob security", memory)
        expect(denied.ok).toBe(false)
    })

    test.skipIf(skipLink !== undefined)(`rejects memory-root link traversal before scanning${skipLink ? ` (skipped: ${skipLink})` : ""}`, async (): Promise<void> => {
        const link = path.join(memory, "escape")
        symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        expect(realpathSync(link).toLowerCase()).toBe(realpathSync(outside).toLowerCase())
        const scan = spyOn(Glob.prototype, "scan")
        try {
            const result = await expandAuthorizedMarkdownGlob(path.join(link, "*.md"), context, "glob security", memory)
            expect(result.ok).toBe(false)
            expect(JSON.stringify(result)).not.toContain(secret)
            expect(scan).not.toHaveBeenCalled()
            expect(readFileSync(path.join(outside, "secret.md"), "utf8")).toBe(secret)
        }
        finally {
            scan.mockRestore()
        }
    })
})
