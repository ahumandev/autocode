import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { validateFilePath } from "./validate_file_path"

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

describe("validate file path", () => {
    // Type check: non-string or empty input must be rejected.
    test("Rejects non-string number input", async () => {
        const result = await validateFilePath(42 as unknown as string, { failedAction: "test-type" })
        expect(result.ok).toBe(false)
    })

    test("Rejects null input", async () => {
        const result = await validateFilePath(null as unknown as string, { failedAction: "test-type" })
        expect(result.ok).toBe(false)
    })

    test("Rejects empty string input", async () => {
        const result = await validateFilePath("", { failedAction: "test-type" })
        expect(result.ok).toBe(false)
    })

    // Glob check: any wildcard metacharacter must be rejected.
    test("Rejects asterisk in input", async () => {
        const result = await validateFilePath("*.json", { failedAction: "test-glob" })
        expect(result.ok).toBe(false)
    })

    test("Rejects question mark in input", async () => {
        const result = await validateFilePath("config?.yaml", { failedAction: "test-glob" })
        expect(result.ok).toBe(false)
    })

    test("Rejects square brackets in input", async () => {
        const result = await validateFilePath("[abc].toml", { failedAction: "test-glob" })
        expect(result.ok).toBe(false)
    })

    test("Rejects curly braces in input", async () => {
        const result = await validateFilePath("{a,b}.ini", { failedAction: "test-glob" })
        expect(result.ok).toBe(false)
    })

    // Existence policy = "off": never stat; any non-empty, glob-free input passes.
    test("Passes for non-existent absolute path under cwd", async () => {
        const absolutePath = join(process.cwd(), `vfp-off-${randomUUID()}.json`)
        const result = await validateFilePath(absolutePath, { failedAction: "test-off", existence: "off" })
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value).toBe(absolutePath)
    })

    // Existence policy = "bare-filename-only": stat only when input has no separator.
    test("Passes for existing bare filename in cwd", async () => {
        const filename = `vfp-existing-${randomUUID()}.json`
        const absolutePath = track(join(process.cwd(), filename))
        await writeFile(absolutePath, "{}")
        const result = await validateFilePath(filename, { failedAction: "test-bare", existence: "bare-filename-only" })
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value).toBe(absolutePath)
    })

    test("Rejects missing bare filename", async () => {
        const filename = `vfp-missing-${randomUUID()}.json`
        const result = await validateFilePath(filename, { failedAction: "test-bare", existence: "bare-filename-only" })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("file not found")
    })

    test("Passes for path-with-separator that does not exist", async () => {
        const input = `./vfp-nonexistent-${randomUUID()}.json`
        const result = await validateFilePath(input, { failedAction: "test-bare", existence: "bare-filename-only" })
        expect(result.ok).toBe(true)
    })

    // Existence policy = "always": every input must point at an existing regular file.
    test("Passes for existing absolute file", async () => {
        const dir = track(await mkdtemp(join(tmpdir(), "vfp-")))
        const file = track(join(dir, "file.json"))
        await writeFile(file, "{}")
        const result = await validateFilePath(file, { failedAction: "test-always", existence: "always" })
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.value).toBe(file)
    })

    test("Rejects missing absolute file", async () => {
        const missing = join(tmpdir(), `vfp-nonexistent-${randomUUID()}.json`)
        const result = await validateFilePath(missing, { failedAction: "test-always", existence: "always" })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("file not found")
    })

    test("Rejects directory when policy is always", async () => {
        const dir = track(await mkdtemp(join(tmpdir(), "vfp-")))
        const result = await validateFilePath(dir, { failedAction: "test-always", existence: "always" })
        expect(result.ok).toBe(false)
    })

    // CWD boundary with no context: inside is always fine; outside depends on requireContextForExternalPaths.
    test("Passes for path inside cwd with no context and existence off", async () => {
        const file = track(join(process.cwd(), `vfp-cwd-${randomUUID()}.json`))
        await writeFile(file, "{}")
        const result = await validateFilePath(file, { failedAction: "test-cwd", existence: "off" })
        expect(result.ok).toBe(true)
    })

    test("Passes for path outside cwd when no context and requireContextForExternalPaths is false", async () => {
        const dir = track(await mkdtemp(join(tmpdir(), "vfp-")))
        const result = await validateFilePath(dir, {
            failedAction: "test-cwd",
            existence: "off",
            requireContextForExternalPaths: false,
        })
        expect(result.ok).toBe(true)
    })

    test("Fails for path outside cwd when no context and requireContextForExternalPaths is true", async () => {
        const dir = track(await mkdtemp(join(tmpdir(), "vfp-")))
        const result = await validateFilePath(dir, {
            failedAction: "test-cwd",
            existence: "off",
            requireContextForExternalPaths: true,
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("current working directory")
    })

    // Result shape: success yields { ok, value }; failure yields { ok, response }.
    test("Success result has ok true and string value", async () => {
        const file = track(join(process.cwd(), `vfp-shape-${randomUUID()}.json`))
        await writeFile(file, "{}")
        const result = await validateFilePath(file, { failedAction: "test-shape" })
        expect(result.ok).toBe(true)
        if (result.ok) {
            expect(typeof result.value).toBe("string")
            expect(result.value.length).toBeGreaterThan(0)
        }
    })

    test("Error result has ok false and non-empty response string", async () => {
        const result = await validateFilePath("", { failedAction: "test-shape" })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(typeof result.response).toBe("string")
            expect(result.response.length).toBeGreaterThan(0)
        }
    })

    // Error message content: phrasing should hint at the cause.
    test("Empty input error mentions required or file_path", async () => {
        const result = await validateFilePath("", { failedAction: "test-msg" })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            const has = result.response.includes("required") || result.response.includes("file_path")
            expect(has).toBe(true)
        }
    })

    test("Glob error response contains the word glob", async () => {
        const result = await validateFilePath("*.json", { failedAction: "test-msg" })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.response).toContain("glob")
    })
})
