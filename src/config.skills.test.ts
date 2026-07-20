import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadAutocodeConfig, type ConfigFileSystem } from "./config"

const DEFAULT_SKILLS = {
    bash: [
        "https://github.com/github/awesome-copilot/blob/main/skills/create-spring-boot-kotlin-project/SKILL.md",
        "https://github.com/github/awesome-copilot/blob/main/skills/drawio/SKILL.md",
    ],
    code: [
        "https://github.com/angular/skills",
        "https://github.com/antfu/skills/blob/main/skills/nitro/SKILL.md",
        "https://github.com/antfu/skills/blob/main/skills/nuxt/SKILL.md",
        "https://github.com/pedronauck/skills/blob/main/skills/mine/tailwindcss/SKILL.md",
        "https://github.com/pedronauck/skills/blob/main/skills/mine/ui-craft/SKILL.md",
        "https://github.com/vuejs-ai/skills/blob/main/skills/vue-best-practices/SKILL.md",
    ],
    design: [
        "https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md",
    ],
    test: [
        "https://github.com/github/awesome-copilot/blob/main/skills/java-junit/SKILL.md",
        "https://github.com/github/awesome-copilot/blob/main/skills/javascript-typescript-jest/SKILL.md",
        "https://github.com/antfu/skills/blob/main/skills/vitest/SKILL.md",
    ],
}

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
            return files[path]!
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

    test("file missing → mock receives ensureFileSync with the default config (4-category skills block)", async () => {
        const { fs, files, createdPaths } = makeFs({})

        await loadAutocodeConfig("/wt", "/wt", fs)

        expect(createdPaths).toContain(globalPath())
        const ensured = files[globalPath()]
        expect(ensured).toBeDefined()
        expect(ensured).toContain("skills")
        expect(ensured).toContain("bash")
        expect(ensured).toContain("code")
        expect(ensured).toContain("design")
        expect(ensured).toContain("test")
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
        const written = files[globalPath()]!
        const parsed = JSON.parse(written)
        expect(parsed.autocode.skills).toEqual(DEFAULT_SKILLS)
        // Other sections MUST be preserved verbatim - never replaced.
        expect(parsed.autocode.sandbox).toEqual({ sync_method: "copy" })
        expect(parsed.autocode.learned).toEqual({ max: 50 })
        // No other top-level keys should appear inside autocode.
        const autocodeKeys = Object.keys(parsed.autocode).sort()
        expect(autocodeKeys).toEqual(["learned", "sandbox", "skills"])
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

    test("file exists with skills: { bash: ['...'] } → result.skills.bash has the URL and no write-back happens", async () => {
        const url = "https://github.com/o/p/blob/main/skills/s/SKILL.md"
        const existingContent = preCreateRealFile(JSON.stringify({ autocode: { skills: { bash: [url] } } }))
        const { fs } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills?.bash).toEqual([url])
        const written = readFileSync(globalPath(), "utf-8")
        expect(written).toBe(existingContent)
    })

    test("idempotency: second load with skills key present does not write back", async () => {
        const existingContent = preCreateRealFile(JSON.stringify({ autocode: {} }))
        const { fs, files } = makeFs({ [globalPath()]: existingContent })

        // First load seeds the skills block via the fs mock.
        await loadAutocodeConfig("/wt", "/wt", fs)
        const afterFirst = files[globalPath()]!
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
        const written = files[globalPath()]!
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
