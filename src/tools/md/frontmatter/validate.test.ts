import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { validateContentPath } from "./validate"

const tempPaths: string[] = []

afterEach(async () => {
    while (tempPaths.length > 0) {
        const p = tempPaths.pop()!
        await rm(p, { recursive: true, force: true }).catch(() => {})
    }
})

function track(path: string): string {
    tempPaths.push(path)
    return path
}

describe("validate content path", () => {
    // Type and empty guards: any non-string or empty/whitespace input must be rejected.
    test("Rejects non-string input", async () => {
        const result = await validateContentPath(42)
        expect(result.ok).toBe(false)
    })

    test("Rejects empty or whitespace string", async () => {
        const empty = await validateContentPath("")
        expect(empty.ok).toBe(false)
        const whitespace = await validateContentPath("   ")
        expect(whitespace.ok).toBe(false)
    })

    // Glob, NUL, and unsupported-extension checks must fire before the filesystem call.
    test("Rejects glob input", async () => {
        const result = await validateContentPath("*.md")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("glob")
    })

    test("Rejects NUL byte input", async () => {
        const result = await validateContentPath(`file-${randomUUID()}.md\0.md`)
        expect(result.ok).toBe(false)
        if (!result.ok) {
            const lower = result.response.toLowerCase()
            expect(lower.includes("nul")).toBe(true)
        }
    })

    test("Rejects unsupported extension", async () => {
        const result = await validateContentPath(`notes-${randomUUID()}.txt`)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain(".md")
    })

    // Happy path: existing file in cwd returns the full ContentTarget triple.
    test("Returns inputPath, absolutePath, and mode for existing file in cwd", async () => {
        const filename = `content-existing-${randomUUID()}.md`
        const absolutePath = track(join(process.cwd(), filename))
        await writeFile(absolutePath, "---\nkey: val\n---\nbody")
        const result = await validateContentPath(filename)
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.value.inputPath).toBe(filename)
            expect(result.value.absolutePath).toBe(absolutePath)
            expect(result.value.mode).toBe("markdown")
        }
    })

    // Outside cwd without context: requireContextForExternalPaths forces a refusal.
    test("Rejects path outside cwd when no context is provided", async () => {
        const dir = track(await mkdtemp(join(tmpdir(), "content-ext-")))
        const file = track(join(dir, `outside-${randomUUID()}.md`))
        await writeFile(file, "body")
        const result = await validateContentPath(file)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("current working directory")
    })

    // Existence is always required, so a missing path in cwd must fail.
    test("Rejects missing file in cwd", async () => {
        const filename = `content-missing-${randomUUID()}.md`
        const result = await validateContentPath(filename)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("file not found")
    })
})
