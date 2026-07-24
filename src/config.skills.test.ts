import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { loadAutocodeConfig, type ConfigFileSystem } from "./config"

const DEFAULT_SKILLS = { freeze: false }

function makeFs(initialFiles: Record<string, string> = {}): {
    fs: ConfigFileSystem
    files: Record<string, string>
    readPaths: string[]
    createdPaths: string[]
    writtenPaths: string[]
} {
    const files: Record<string, string> = { ...initialFiles }
    const readPaths: string[] = []
    const createdPaths: string[] = []
    const writtenPaths: string[] = []

    const fs: ConfigFileSystem = {
        readFileSync(path, _encoding) {
            readPaths.push(path)
            if (!(path in files)) {
                const err = new Error("ENOENT") as NodeJS.ErrnoException
                err.code = "ENOENT"
                throw err
            }
            return files[path] ?? ""
        },
        ensureFileSync(path, contents) {
            if (!(path in files)) {
                files[path] = contents
                createdPaths.push(path)
            }
        },
        writeFileSync(path, contents) {
            files[path] = contents
            writtenPaths.push(path)
        },
    }

    return { fs, files, readPaths, createdPaths, writtenPaths }
}

describe("skills config parsing and seeding", () => {
    let tempDir: string
    let originalXdg: string | undefined
    let originalHome: string | undefined

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "autocode-skills-test-"))
        originalXdg = process.env.XDG_CONFIG_HOME
        originalHome = process.env.HOME
        process.env.XDG_CONFIG_HOME = tempDir
        // Redirect HOME too so the `homedir()` fallback in config.ts cannot
        // reach the real user config.
        process.env.HOME = tempDir
    })

    afterEach(() => {
        if (originalXdg === undefined) {
            delete process.env.XDG_CONFIG_HOME
        } else {
            process.env.XDG_CONFIG_HOME = originalXdg
        }
        if (originalHome === undefined) {
            delete process.env.HOME
        } else {
            process.env.HOME = originalHome
        }
        rmSync(tempDir, { recursive: true, force: true })
    })

    function globalPath(): string {
        return join(tempDir, "opencode", "autocode.jsonc")
    }

    function preCreateRealFile(content: string): string {
        mkdirSync(join(tempDir, "opencode"), { recursive: true })
        writeFileSync(globalPath(), content)
        return content
    }

    test("file missing → mock receives ensureFileSync with freeze disabled by default", async () => {
        const { fs, files, createdPaths } = makeFs({})

        await loadAutocodeConfig("/wt", "/wt", fs)

        expect(createdPaths).toContain(globalPath())
        const ensured = files[globalPath()]
        expect(ensured).toBeDefined()
        expect(ensured).toContain("skills")
        expect(ensured).toContain('"freeze": false')
    })

    test("file exists with no skills key → result.skills equals default, write-back preserves existing sections, skills block added", async () => {
        const existingContent = preCreateRealFile(JSON.stringify({
            autocode: {
                sandbox: { sync_method: "copy" },
                learned: { max: 50 },
            },
        }))
        const { fs, files, writtenPaths } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toEqual(DEFAULT_SKILLS)

        // Seeding now writes through the injected fs mock — verify via the in-memory
        // files dict + writtenPaths tracker.
        expect(writtenPaths).toContain(globalPath())
        const written = files[globalPath()] ?? ""
        const parsed = JSON.parse(written)
        expect(parsed.autocode.skills).toEqual(DEFAULT_SKILLS)
        // Other sections MUST be preserved verbatim - never replaced.
        expect(parsed.autocode.sandbox).toEqual({ sync_method: "copy" })
        expect(parsed.autocode.learned).toEqual({ max: 50 })
        // No other top-level keys should appear inside autocode.
        const autocodeKeys = Object.keys(parsed.autocode).sort()
        expect(autocodeKeys).toEqual(["learned", "sandbox", "skills"])
    })

    test("JSONC missing skills → seed preserves comments, custom tiers, and permission rules", async () => {
        const existingContent = preCreateRealFile(`{
    // named user comment
    "autocode": {
        "tiers": {
            "custom": {
                "fast": { "model": "custom-fast" },
            },
        },
    },
    "permission": {
        "external_directory": {
            "/workspace/**": "allow",
            "*": "ask",
        },
    },
}
`)
        const { fs, files, writtenPaths } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toEqual(DEFAULT_SKILLS)
        expect(writtenPaths).toContain(globalPath())
        const written = files[globalPath()] ?? ""
        const parsed = parseJsonc(written) as {
            autocode: { skills: unknown, tiers: unknown }
            permission: unknown
        }
        expect(parsed.autocode.skills).toEqual(DEFAULT_SKILLS)
        expect(parsed.autocode.tiers).toEqual({
            custom: { fast: { model: "custom-fast" } },
        })
        expect(parsed.permission).toEqual({
            external_directory: {
                "/workspace/**": "allow",
                "*": "ask",
            },
        })
        expect(written).toContain("// named user comment")
    })

    test("file exists with skills: {} → result.skills is undefined and no write-back happens", async () => {
        const existingContent = preCreateRealFile(JSON.stringify({ autocode: { skills: {} } }))
        const { fs } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toBeUndefined()
        const written = readFileSync(globalPath(), "utf-8")
        expect(written).toBe(existingContent)
    })

    test("file exists with skills: null → result.skills is undefined and no write-back happens", async () => {
        const existingContent = preCreateRealFile(JSON.stringify({ autocode: { skills: null } }))
        const { fs } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toBeUndefined()
        const written = readFileSync(globalPath(), "utf-8")
        expect(written).toBe(existingContent)
    })

    test("legacy category arrays are ignored without rewriting config", async () => {
        const url = "https://github.com/o/p/blob/main/skills/s/SKILL.md"
        const existingContent = preCreateRealFile(JSON.stringify({ autocode: { skills: { bash: [url] } } }))
        const { fs } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toBeUndefined()
        const written = readFileSync(globalPath(), "utf-8")
        expect(written).toBe(existingContent)
    })

    test("skills.freeze accepts exact booleans and defaults to false", async () => {
        const missing = makeFs()
        expect((await loadAutocodeConfig("/wt", "/wt", missing.fs)).skills?.freeze).toBe(false)

        for (const freeze of [true, false]) {
            const existingContent = preCreateRealFile(JSON.stringify({ autocode: { skills: { freeze } } }))
            const { fs } = makeFs({ [globalPath()]: existingContent })
            expect((await loadAutocodeConfig("/wt", "/wt", fs)).skills?.freeze).toBe(freeze)
        }
    })

    test("invalid skills.freeze falls back to false", async () => {
        for (const freeze of ["yes", 1, null]) {
            const existingContent = preCreateRealFile(JSON.stringify({ autocode: { skills: { freeze } } }))
            const { fs } = makeFs({ [globalPath()]: existingContent })

            expect((await loadAutocodeConfig("/wt", "/wt", fs)).skills?.freeze).toBe(false)
        }
    })

    test("local freeze setting overrides global config tier", async () => {
        const global = preCreateRealFile(JSON.stringify({ autocode: { skills: { freeze: false } } }))
        const localPath = join("/wt", ".opencode", "autocode.jsonc")
        const { fs } = makeFs({
            [globalPath()]: global,
            [localPath]: JSON.stringify({ autocode: { skills: { freeze: true } } }),
        })

        expect((await loadAutocodeConfig("/wt", "/wt", fs)).skills?.freeze).toBe(true)
    })

    test("idempotency: second load with skills key present does not write back", async () => {
        const existingContent = preCreateRealFile(JSON.stringify({ autocode: {} }))
        const { fs, files } = makeFs({ [globalPath()]: existingContent })

        // First load seeds the skills block via the fs mock.
        await loadAutocodeConfig("/wt", "/wt", fs)
        const afterFirst = files[globalPath()] ?? ""
        expect(JSON.parse(afterFirst).autocode.skills).toEqual(DEFAULT_SKILLS)

        // Second load must not re-write the file. Re-create fs with the post-seed
        // content so the read sees the skills key already present.
        const second = makeFs({ [globalPath()]: afterFirst })
        await loadAutocodeConfig("/wt", "/wt", second.fs)
        expect(second.writtenPaths).not.toContain(globalPath())
        expect(second.files[globalPath()]).toBe(afterFirst)
    })

    test("invalid skills value (string) → result.skills is undefined and no write-back", async () => {
        const existingContent = preCreateRealFile(JSON.stringify({ autocode: { skills: "not-an-object" } }))
        const { fs } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toBeUndefined()
        const written = readFileSync(globalPath(), "utf-8")
        expect(written).toBe(existingContent)
    })

    test("invalid skills value (number) → result.skills is undefined and no write-back", async () => {
        const existingContent = preCreateRealFile(JSON.stringify({ autocode: { skills: 123 } }))
        const { fs } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toBeUndefined()
        const written = readFileSync(globalPath(), "utf-8")
        expect(written).toBe(existingContent)
    })

    test("invalid skills value (array) → result.skills is undefined and no write-back", async () => {
        const existingContent = preCreateRealFile(JSON.stringify({ autocode: { skills: ["array"] } }))
        const { fs } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toBeUndefined()
        const written = readFileSync(globalPath(), "utf-8")
        expect(written).toBe(existingContent)
    })

    test("regression: existing tiers section preserved when seeding adds skills", async () => {
        // User reported bug: seeding replaces entire tiers section with invalid config.
        // Verify tiers is preserved verbatim when skills key is added.
        const existingContent = preCreateRealFile(JSON.stringify({
            autocode: {
                tier: "openai",
                tiers: {
                    openai: {
                        fast: { model: "global-fast" },
                        smart: { model: "global-smart" },
                    },
                    anthropic: {
                        fast: { model: "unused-fast" },
                    },
                },
            },
        }))
        const { fs, files, writtenPaths } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toEqual(DEFAULT_SKILLS)

        expect(writtenPaths).toContain(globalPath())
        const written = files[globalPath()] ?? ""
        const parsed = JSON.parse(written)
        // skills block added.
        expect(parsed.autocode.skills).toEqual(DEFAULT_SKILLS)
        // tier + tiers section MUST be preserved verbatim - never touched.
        expect(parsed.autocode.tier).toBe("openai")
        expect(parsed.autocode.tiers).toEqual({
            openai: {
                fast: { model: "global-fast" },
                smart: { model: "global-smart" },
            },
            anthropic: {
                fast: { model: "unused-fast" },
            },
        })
        // autocode must contain exactly: tier, tiers, skills - nothing else replaced.
        const autocodeKeys = Object.keys(parsed.autocode).sort()
        expect(autocodeKeys).toEqual(["skills", "tier", "tiers"])
    })

    test("regression: non-record autocode (array) → seeding skipped, file untouched", async () => {
        // Previously the seeding would replace `autocode: [...]` with `{ skills: ... }`,
        // wiping user's custom value entirely. Verify this NEVER happens anymore.
        const existingContent = preCreateRealFile(JSON.stringify({
            autocode: ["custom", "array", "value"],
        }))
        const { fs } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        // No skills returned (seeding skipped because ac is not a record).
        expect(result.skills).toBeUndefined()

        // File MUST be byte-for-byte identical — autocode array preserved.
        const written = readFileSync(globalPath(), "utf-8")
        expect(written).toBe(existingContent)
    })

    test("regression: non-record autocode (string) → seeding skipped, file untouched", async () => {
        const existingContent = preCreateRealFile(JSON.stringify({
            autocode: "custom-string-value",
        }))
        const { fs } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toBeUndefined()

        const written = readFileSync(globalPath(), "utf-8")
        expect(written).toBe(existingContent)
    })

    test("regression: non-record autocode (number) → seeding skipped, file untouched", async () => {
        const existingContent = preCreateRealFile(JSON.stringify({
            autocode: 12345,
        }))
        const { fs } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toBeUndefined()

        const written = readFileSync(globalPath(), "utf-8")
        expect(written).toBe(existingContent)
    })

    test("regression: null autocode → seeding skipped, file untouched", async () => {
        const existingContent = preCreateRealFile(JSON.stringify({
            autocode: null,
        }))
        const { fs } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toBeUndefined()

        const written = readFileSync(globalPath(), "utf-8")
        expect(written).toBe(existingContent)
    })
})
