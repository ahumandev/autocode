import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createLocalConfigAdapter } from "./adapter"

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

describe("validate config path", () => {
    // Type/empty guards: any non-string or empty input must be rejected.
    test("Rejects non-string input", async () => {
        const adapter = createLocalConfigAdapter(undefined)
        const result = await adapter.validateConfigPath(42 as unknown as string)
        expect(result.ok).toBe(false)
    })

    test("Rejects empty string", async () => {
        const adapter = createLocalConfigAdapter(undefined)
        const result = await adapter.validateConfigPath("")
        expect(result.ok).toBe(false)
    })

    // Glob and extension checks: wildcards and disallowed extensions must be rejected.
    test("Rejects glob input", async () => {
        const adapter = createLocalConfigAdapter(undefined)
        const result = await adapter.validateConfigPath("*.json")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("glob")
    })

    test("Rejects markdown extension", async () => {
        const adapter = createLocalConfigAdapter(undefined)
        const result = await adapter.validateConfigPath("README.md")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("markdown")
    })

    test("Rejects unsupported extension", async () => {
        const adapter = createLocalConfigAdapter(undefined)
        const result = await adapter.validateConfigPath(`notes-${randomUUID()}.txt`)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("unsupported")
    })

    // Happy path: an existing absolute file resolves with mode inferred from extension.
    test("Returns absolute path and mode for existing absolute file", async () => {
        const adapter = createLocalConfigAdapter(undefined)
        const dir = track(await mkdtemp(join(tmpdir(), "cfg-adapter-")))
        const file = track(join(dir, `config-${randomUUID()}.json`))
        await writeFile(file, "{}")
        const result = await adapter.validateConfigPath(file)
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(result.value.absolutePath).toBe(file)
            expect(result.value.mode).toBe("json")
        }
    })

    // Existence semantics inherited from bare-filename-only policy.
    test("Rejects missing bare filename in cwd", async () => {
        const adapter = createLocalConfigAdapter(undefined)
        const filename = `cfg-missing-${randomUUID()}.json`
        const result = await adapter.validateConfigPath(filename)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("file not found")
    })

    test("Passes for path with separator that does not exist", async () => {
        const adapter = createLocalConfigAdapter(undefined)
        const input = `./cfg-nonexistent-${randomUUID()}.json`
        const result = await adapter.validateConfigPath(input)
        expect(result.ok).toBe(true)
    })
})
