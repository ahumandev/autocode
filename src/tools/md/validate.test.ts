import { afterEach, describe, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { validateMdPath } from "./validate"

const tempPaths: string[] = []

afterEach(async () => {
    while (tempPaths.length > 0) {
        const p = tempPaths.pop()
        if (p !== undefined) {
            await rm(p, { recursive: true, force: true }).catch(() => {})
        }
    }
})

function track(path: string): string {
    tempPaths.push(path)
    return path
}

describe("validate md path", () => {
    // Type/empty guards and glob check must reject before any filesystem work.
    test("Rejects non-string input", async () => {
        const ctx = undefined as unknown as ToolContext
        const result = await validateMdPath(ctx, 42 as unknown as string, "test")
        expect(result.ok).toBe(false)
    })

    test("Rejects empty string", async () => {
        const ctx = undefined as unknown as ToolContext
        const result = await validateMdPath(ctx, "", "test")
        expect(result.ok).toBe(false)
    })

    test("Rejects glob input", async () => {
        const ctx = undefined as unknown as ToolContext
        const result = await validateMdPath(ctx, "*.md", "test")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("glob")
    })

    // Default policy: no existence check, so a missing bare filename still passes.
    test("Passes for missing bare filename with default policy", async () => {
        const ctx = undefined as unknown as ToolContext
        const filename = `md-missing-${randomUUID()}.md`
        const result = await validateMdPath(ctx, filename, "test")
        expect(result.ok).toBe(true)
    })

    // With requireExistence, bare filenames must exist in cwd; missing ones fail.
    test("Passes for existing bare filename in cwd when requireExistence is true", async () => {
        const ctx = undefined as unknown as ToolContext
        const filename = `md-existing-${randomUUID()}.md`
        const absolutePath = track(join(process.cwd(), filename))
        await writeFile(absolutePath, "# hi")
        const result = await validateMdPath(ctx, filename, "test", { requireExistence: true })
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value).toBe(absolutePath)
    })

    test("Rejects missing bare filename when requireExistence is true", async () => {
        const ctx = undefined as unknown as ToolContext
        const filename = `md-missing-${randomUUID()}.md`
        const result = await validateMdPath(ctx, filename, "test", { requireExistence: true })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("file not found")
    })

    // Bare-filename-only skips paths with separators even when requireExistence is true.
    test("Passes for path with separator that does not exist when requireExistence is true", async () => {
        const ctx = undefined as unknown as ToolContext
        const input = `./md-nonexistent-${randomUUID()}.md`
        const result = await validateMdPath(ctx, input, "test", { requireExistence: true })
        expect(result.ok).toBe(true)
    })
})
