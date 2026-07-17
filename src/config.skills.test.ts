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
} {
    const files: Record<string, string> = { ...initialFiles }
    const readPaths: string[] = []
    const createdPaths: string[] = []

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
    }

    return { fs, files, readPaths, createdPaths }
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

    test("file exists with no skills key → result.skills equals default and the real file is written back with skills block", async () => {
        const existingContent = preCreateRealFile(JSON.stringify({ autocode: { sandbox: { sync_method: "copy" } } }))
        const { fs } = makeFs({ [globalPath()]: existingContent })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills).toEqual(DEFAULT_SKILLS)

        // The source's seed step uses real writeFileSync (not the injected fs),
        // so verify the write-back on the real file under the temp dir.
        const written = readFileSync(globalPath(), "utf-8")
        const parsed = JSON.parse(written)
        expect(parsed.autocode.skills).toEqual(DEFAULT_SKILLS)
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

        // First load seeds the skills block into the real file.
        await loadAutocodeConfig("/wt", "/wt", fs)
        const afterFirst = readFileSync(globalPath(), "utf-8")
        expect(JSON.parse(afterFirst).autocode.skills).toEqual(DEFAULT_SKILLS)

        // Sync the in-memory mock to the real on-disk state so the second
        // load reads a file that already carries the skills key.
        files[globalPath()] = afterFirst

        // Second load must not re-write the file.
        await loadAutocodeConfig("/wt", "/wt", fs)
        const afterSecond = readFileSync(globalPath(), "utf-8")
        expect(afterSecond).toBe(afterFirst)
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
})
