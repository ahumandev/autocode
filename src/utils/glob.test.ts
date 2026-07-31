import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { absoluteScanCwd, expandGlob } from "./glob"

const tempPaths: string[] = []

afterEach(async () => {
    while (tempPaths.length > 0) {
        const p = tempPaths.pop()
        if (!p) continue
        await rm(p, { recursive: true, force: true }).catch(() => {})
    }
})

async function makeOutsideFile(name: string, content = "x"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "glob-test-"))
    tempPaths.push(dir)
    const file = join(dir, name)
    await writeFile(file, content)
    return file
}

describe("expandGlob", () => {
    const cwd = process.cwd()

    test("absolute literal path inside cwd returns relative key", async () => {
        const pattern = join(cwd, "AGENTS.md")
        const result = await expandGlob(pattern, cwd)
        expect(result).toHaveLength(1)
        expect(result[0].absolute).toBe(pattern)
        expect(result[0].key).toBe("AGENTS.md")
    })

    test("absolute literal path outside cwd returns absolute key", async () => {
        const outside = await makeOutsideFile("outside.txt")
        const result = await expandGlob(outside, cwd)
        expect(result).toHaveLength(1)
        expect(result[0].absolute).toBe(outside)
        expect(result[0].key).toBe(outside)
    })

    test("absolute literal path that does not exist returns empty array", async () => {
        const missing = join(cwd, "definitely-not-a-real-file-xyzzy-12345.bin")
        const result = await expandGlob(missing, cwd)
        expect(result).toEqual([])
    })

    test("relative literal path returns one match", async () => {
        const result = await expandGlob("AGENTS.md", cwd)
        expect(result).toHaveLength(1)
        expect(result[0].key).toBe("AGENTS.md")
        expect(result[0].absolute).toBe(join(cwd, "AGENTS.md"))
    })

    test("absolute glob with metacharacters resolves to matching files", async () => {
        const pattern = join(cwd, "src", "utils", "*.ts")
        const result = await expandGlob(pattern, cwd)
        expect(result.length).toBeGreaterThanOrEqual(1)
        for (const match of result) {
            expect(match.absolute.startsWith(join(cwd, "src", "utils"))).toBe(true)
        }
    })

    test("relative glob with metacharacters includes glob.ts", async () => {
        const result = await expandGlob("src/utils/glob*.ts", cwd)
        expect(result.length).toBeGreaterThanOrEqual(1)
        const absolutes = result.map((m) => m.absolute)
        expect(absolutes).toContain(join(cwd, "src", "utils", "glob.ts"))
    })

    test("non-existent relative literal path returns empty array", async () => {
        const result = await expandGlob("definitely-not-a-real-file-xyzzy-12345.bin", cwd)
        expect(result).toEqual([])
    })

    test("absolute path to a DIRECTORY returns empty array (respects onlyFiles semantic)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "glob-test-"))
        tempPaths.push(dir)
        try {
            const result = await expandGlob(dir, cwd)
            expect(result).toEqual([])
        } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => {})
        }
    })
})

describe("absoluteScanCwd", () => {
    test("returns parent of first glob segment for absolute path styles", async () => {
        const cases: Array<{ pattern: string; expected: string }> = [
            { pattern: "/a/*.ts", expected: "/a" },
            { pattern: "/*.ts", expected: "/" },
            { pattern: "/a/foo*.ts", expected: "/a" },
            { pattern: "/a/{one,two}/*.ts", expected: "/a" },
            { pattern: "C:\\*.ts", expected: "C:\\" },
            { pattern: "C:\\a\\*.ts", expected: "C:\\a" },
            { pattern: "C:\\a\\foo*.ts", expected: "C:\\a" },
            { pattern: "\\\\server\\share\\*.ts", expected: "\\\\server\\share\\" },
            { pattern: "\\\\server\\share\\a\\*.ts", expected: "\\\\server\\share\\a" },
            { pattern: "C:/a\\b/*.ts", expected: "C:\\a\\b" },
        ]

        for (const { pattern, expected } of cases) {
            expect(absoluteScanCwd(pattern)).toBe(expected)
        }
    })
})
