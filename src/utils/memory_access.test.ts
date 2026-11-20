import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { canonicalizeExistingOrMissingPath, classifyMemoryPath, isPathWithin } from "./memory_access"

describe("isPathWithin", () => {
    test("enforces POSIX boundaries, traversal, and case sensitivity", () => {
        expect(isPathWithin("/work/memory", "/work/memory")).toBe(true)
        expect(isPathWithin("/work/memory", "/work/memory/notes/../entry.md")).toBe(true)
        expect(isPathWithin("/work/memory", "/work/memory-sibling/entry.md")).toBe(false)
        expect(isPathWithin("/work/memory", "/work/memory/../secret.md")).toBe(false)
        expect(isPathWithin("/work/memory", "/work/Memory/entry.md")).toBe(false)
    })

    test("normalizes Windows drive paths independently of the host", () => {
        expect(isPathWithin("C:\\Work\\Memory", "c:/work/memory")).toBe(true)
        expect(isPathWithin("C:\\Work\\Memory", "c:/WORK/memory/notes/../ENTRY.md")).toBe(true)
        expect(isPathWithin("C:\\Work\\Memory", "C:\\Work\\Memory-sibling\\entry.md")).toBe(false)
        expect(isPathWithin("C:\\Work\\Memory", "C:\\Work\\Memory\\..\\secret.md")).toBe(false)
        expect(isPathWithin("C:\\Work\\Memory", "D:\\Work\\Memory\\entry.md")).toBe(false)
        expect(isPathWithin("C:\\Work\\Memory", "/work/memory/entry.md")).toBe(false)
        expect(isPathWithin("/work/memory", "C:\\Work\\Memory\\entry.md")).toBe(false)
    })

    test("equates Windows UNC and extended-length paths without crossing shares", () => {
        expect(isPathWithin("C:\\Work\\Memory", "\\\\?\\C:\\WORK\\MEMORY\\entry.md")).toBe(true)
        expect(isPathWithin("\\\\?\\C:\\Work\\Memory", "c:/work/memory/entry.md")).toBe(true)
        expect(isPathWithin("\\\\Server\\Share\\Memory", "\\\\?\\UNC\\server\\share\\memory\\entry.md")).toBe(true)
        expect(isPathWithin("\\\\?\\UNC\\Server\\Share\\Memory", "//server/share/memory/entry.md")).toBe(true)
        expect(isPathWithin("\\\\server\\share\\memory", "\\\\server\\share\\memory-other\\entry.md")).toBe(false)
        expect(isPathWithin("\\\\server\\share\\memory", "\\\\server\\other\\memory\\entry.md")).toBe(false)
        expect(isPathWithin("\\\\server\\share\\memory", "\\\\other\\share\\memory\\entry.md")).toBe(false)
    })
})

describe("memory path filesystem security", () => {
    let temporary: string
    let project: string
    let root: string
    let outside: string

    beforeEach(async () => {
        temporary = await mkdtemp(path.join(tmpdir(), "memory-access-test-"))
        project = path.join(temporary, "project")
        root = path.join(project, "memory")
        outside = path.join(temporary, "outside")
        await mkdir(root, { recursive: true })
        await mkdir(outside)
    })

    afterEach(async () => {
        if (temporary) await rm(temporary, { recursive: true, force: true })
    })

    test("classifies the default project root and its descendants", async () => {
        const defaultRoot = path.join(project, ".opencode", "autocode", "memory")
        await mkdir(defaultRoot, { recursive: true })
        const entry = path.join(defaultRoot, "entry.md")
        await writeFile(entry, "owned")

        for (const configured of [undefined, "", "  "]) {
            expect(await classifyMemoryPath(project, configured, defaultRoot)).toBe("allowed")
            expect(await classifyMemoryPath(project, configured, entry)).toBe("allowed")
            expect(await classifyMemoryPath(project, configured, path.join(project, ".opencode", "memory-other", "entry.md"))).toBe("outside")
            expect(await classifyMemoryPath(project, configured, path.join(project, ".opencode", "memory", "entry.md"))).toBe("outside")
        }
    })

    test("resolves configured relative and absolute roots and equal boundaries", async () => {
        const entry = path.join(root, "entry.md")
        await writeFile(entry, "owned")
        expect(await classifyMemoryPath(project, "memory", root)).toBe("allowed")
        expect(await classifyMemoryPath(project, "memory", path.join("memory", "entry.md"))).toBe("allowed")
        expect(await classifyMemoryPath(project, root, entry)).toBe("allowed")
        expect(await classifyMemoryPath(project, outside, outside)).toBe("allowed")
        expect(await classifyMemoryPath(project, outside, entry)).toBe("outside")
        expect(await classifyMemoryPath(project, "memory", `${root}-other${path.sep}entry.md`)).toBe("outside")
    })

    test("rejects lexical escapes and permits normalized paths within the root", async () => {
        const within = `memory${path.sep}nested${path.sep}..${path.sep}entry.md`
        const escape = `memory${path.sep}..${path.sep}outside.md`
        await mkdir(path.join(root, "nested"))
        expect(await classifyMemoryPath(project, "memory", within)).toBe("allowed")
        expect(await classifyMemoryPath(project, "memory", escape)).toBe("outside")
        expect(await classifyMemoryPath(project, "memory", path.join(outside, "entry.md"))).toBe("outside")
    })

    test("canonicalizes existing files and missing descendants against the real ancestor", async () => {
        const file = path.join(root, "entry.md")
        await writeFile(file, "owned")
        const canonicalRoot = await realpath(root)
        expect(await canonicalizeExistingOrMissingPath(file)).toBe(path.join(canonicalRoot, "entry.md"))
        expect(await canonicalizeExistingOrMissingPath(path.join(root, "missing", "entry.md"))).toBe(path.join(canonicalRoot, "missing", "entry.md"))
        expect(await classifyMemoryPath(project, "memory", path.join(root, "missing", "entry.md"))).toBe("allowed")
    })

    test("allows a missing root and descendants without confusing sibling prefixes", async () => {
        const missingRoot = path.join(project, "new", "memory")
        const canonicalProject = await realpath(project)
        expect(await canonicalizeExistingOrMissingPath(missingRoot)).toBe(path.join(canonicalProject, "new", "memory"))
        expect(await canonicalizeExistingOrMissingPath(path.join(missingRoot, "nested", "entry.md"))).toBe(path.join(canonicalProject, "new", "memory", "nested", "entry.md"))
        expect(await classifyMemoryPath(project, missingRoot, missingRoot)).toBe("allowed")
        expect(await classifyMemoryPath(project, missingRoot, path.join(missingRoot, "nested", "entry.md"))).toBe("allowed")
        expect(await classifyMemoryPath(project, missingRoot, `${missingRoot}-other`)).toBe("outside")
    })

    test("denies missing descendants and traversal through a non-directory ancestor", async () => {
        const file = path.join(root, "file")
        await writeFile(file, "owned")
        const descendant = path.join(file, "child")
        const traversal = `${file}${path.sep}..${path.sep}entry.md`
        await expect(canonicalizeExistingOrMissingPath(descendant)).rejects.toThrow()
        await expect(canonicalizeExistingOrMissingPath(traversal)).rejects.toThrow()
        expect(await classifyMemoryPath(project, "memory", descendant)).toBe("denied")
        expect(await classifyMemoryPath(project, "memory", traversal)).toBe("denied")
        expect(await classifyMemoryPath(project, descendant, path.join(descendant, "entry.md"))).toBe("denied")
    })

    describe.skipIf(process.platform === "win32")("POSIX symbolic links", () => {
        test("denies directory, nested, missing, and file link escapes", async () => {
            const nested = path.join(root, "nested")
            const secret = path.join(outside, "secret.md")
            await mkdir(nested)
            await writeFile(secret, "outside")
            await symlink(outside, path.join(root, "escape"), "dir")
            await symlink(outside, path.join(nested, "escape"), "dir")
            await symlink(secret, path.join(root, "file-link"), "file")

            expect(await canonicalizeExistingOrMissingPath(path.join(root, "escape", "secret.md"))).toBe(await realpath(secret))
            expect(await classifyMemoryPath(project, "memory", path.join(root, "escape"))).toBe("denied")
            expect(await classifyMemoryPath(project, "memory", path.join(root, "escape", "secret.md"))).toBe("denied")
            expect(await classifyMemoryPath(project, "memory", path.join(root, "escape", "missing", "entry.md"))).toBe("denied")
            expect(await classifyMemoryPath(project, "memory", path.join(nested, "escape", "secret.md"))).toBe("denied")
            expect(await classifyMemoryPath(project, "memory", path.join(root, "file-link"))).toBe("denied")
        })

        test("resolves symlinks before parent traversal rather than normalizing them away", async () => {
            const deep = path.join(outside, "deep")
            await mkdir(deep)
            await symlink(deep, path.join(root, "link"), "dir")
            const traversal = `${root}${path.sep}link${path.sep}..${path.sep}secret.md`
            expect(await canonicalizeExistingOrMissingPath(traversal)).toBe(path.join(await realpath(outside), "secret.md"))
            expect(await classifyMemoryPath(project, "memory", traversal)).toBe("denied")
        })

        test("allows an intentional symlink root but denies links escaping its destination", async () => {
            const alias = path.join(project, "alias")
            const entry = path.join(outside, "entry.md")
            await writeFile(entry, "owned")
            await symlink(outside, alias, "dir")
            await symlink(root, path.join(outside, "escape"), "dir")

            expect(await canonicalizeExistingOrMissingPath(alias)).toBe(await realpath(outside))
            expect(await classifyMemoryPath(project, alias, alias)).toBe("allowed")
            expect(await classifyMemoryPath(project, alias, path.join(alias, "entry.md"))).toBe("allowed")
            expect(await classifyMemoryPath(project, alias, path.join(alias, "missing", "entry.md"))).toBe("allowed")
            expect(await classifyMemoryPath(project, alias, path.join(alias, "escape", "entry.md"))).toBe("denied")
            expect(await classifyMemoryPath(project, alias, entry)).toBe("outside")
        })

        test("denies dangling links, broken link ancestors, and symlink loops", async () => {
            const dangling = path.join(root, "dangling")
            const loopA = path.join(root, "loop-a")
            const loopB = path.join(root, "loop-b")
            await symlink(path.join(outside, "missing"), dangling, "dir")
            await symlink(loopB, loopA, "dir")
            await symlink(loopA, loopB, "dir")

            for (const target of [dangling, path.join(dangling, "entry.md"), loopA, path.join(loopA, "entry.md")]) {
                await expect(canonicalizeExistingOrMissingPath(target)).rejects.toThrow()
                expect(await classifyMemoryPath(project, "memory", target)).toBe("denied")
            }
            expect(await classifyMemoryPath(project, dangling, path.join(dangling, "entry.md"))).toBe("denied")
            expect(await classifyMemoryPath(project, loopA, path.join(loopA, "entry.md"))).toBe("denied")
        })
    })

    test.skipIf(process.platform !== "win32")("handles Windows junction escapes and intentional junction roots", async () => {
        const escape = path.join(root, "junction")
        const alias = path.join(project, "alias")
        const entry = path.join(outside, "entry.md")
        await writeFile(entry, "outside")
        await symlink(outside, escape, "junction")
        await symlink(outside, alias, "junction")

        expect(await canonicalizeExistingOrMissingPath(path.join(escape, "entry.md"))).toBe(await realpath(entry))
        expect(await classifyMemoryPath(project, "memory", path.join(escape, "entry.md"))).toBe("denied")
        expect(await classifyMemoryPath(project, "memory", path.join(escape, "missing", "entry.md"))).toBe("denied")
        expect(await classifyMemoryPath(project, alias, alias)).toBe("allowed")
        expect(await classifyMemoryPath(project, alias, path.join(alias, "entry.md"))).toBe("allowed")
    })
})
