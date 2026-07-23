import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from "fs"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { cleanupLearnedSkills, ensureGeneratedSkills, getGeneratedSkillsRoot, managedSkills } from "./index"

const expectedManagedDirectories = [
    "assist-troubleshoot",
    "author-agent",
    "author-article",
    "author-command",
    "author-readme",
    "author-rules",
    "code-java",
    "code-rest",
    "code-typescript",
    "execute-sandbox",
    "git-commit",
    "primary-manual",
    "skill-write",
    "test-jest",
    "test-junit",
    "test-mockito",
    "test-vitest",
]
const sourceSkillPathExpectations = [
    {
        directory: "author-agent",
        pluralPaths: [".opencode/agents/{name}.md", "~/.config/opencode/agents/{name}.md"],
        singularPaths: [".opencode/agent/{name}.md", "~/.config/opencode/agent/{name}.md"],
    },
    {
        directory: "author-command",
        pluralPaths: [".opencode/commands/{name}.md", "~/.config/opencode/commands/{name}.md"],
        singularPaths: [".opencode/command/{name}.md", "~/.config/opencode/command/{name}.md"],
    },
]

const originalHome = process.env.HOME
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const tempRoots: string[] = []

function sourceSkillsRoot(): string {
    return path.join(import.meta.dir, "..", "skills")
}

function sourceSkillDirectories(): string[] {
    return readdirSync(sourceSkillsRoot())
        .filter((entry) => statSync(path.join(sourceSkillsRoot(), entry)).isDirectory())
        .filter((entry) => existsSync(path.join(sourceSkillsRoot(), entry, "SKILL.md")))
        .sort()
}

async function withIsolatedSkillConfigHome<T>(fn: (home: string, xdgConfigHome: string) => Promise<T>): Promise<T> {
    const home = await mkdtemp(path.join(tmpdir(), "autocode-skills-home-"))
    const xdgConfigHome = path.join(home, ".config")
    tempRoots.push(home)

    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = xdgConfigHome

    try {
        return await fn(home, xdgConfigHome)
    } finally {
        if (originalHome === undefined) delete process.env.HOME
        else process.env.HOME = originalHome

        if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    }
}

afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
        rmSync(tempRoot, { recursive: true, force: true })
    }
})

describe("managed skills", () => {
    test("covers expected source skill directories and intentional exclusions", () => {
        const managedDirectories = managedSkills.map((skill) => skill.directory).sort()

        expect(managedDirectories).toEqual(expectedManagedDirectories)
        expect(managedDirectories).toContain("skill-write")
    })

    test("loads name, description, and content for every managed skill", () => {
        for (const skill of managedSkills) {
            expect(skill.name).toBe(skill.directory)
            expect(skill.description.length).toBeGreaterThan(0)
            expect(skill.content.length).toBeGreaterThan(0)
            expect(skill.content.startsWith("---")).toBe(false)
        }
    })

    test("source skill docs use plural OpenCode paths", () => {
        for (const expectation of sourceSkillPathExpectations) {
            const content = readFileSync(path.join(sourceSkillsRoot(), expectation.directory, "SKILL.md"), "utf8")

            for (const pluralPath of expectation.pluralPaths) {
                expect(content).toContain(pluralPath)
            }

            for (const singularPath of expectation.singularPaths) {
                expect(content).not.toContain(singularPath)
            }
        }
    })

    test("ensureGeneratedSkills writes all managed skills under isolated config home", async () => {
        await withIsolatedSkillConfigHome(async (_home, xdgConfigHome) => {
            const expectedRoot = path.join(xdgConfigHome, "skills", "autocode")

            expect(getGeneratedSkillsRoot()).toBe(expectedRoot)

            const generatedRoot = await ensureGeneratedSkills()

            expect(generatedRoot).toBe(expectedRoot)
            expect(existsSync(path.join(generatedRoot, "skill-write", "SKILL.md"))).toBe(true)

            for (const skill of managedSkills) {
                const generatedSkillPath = path.join(generatedRoot, skill.directory, "SKILL.md")
                const generatedContent = readFileSync(generatedSkillPath, "utf8")

                expect(generatedContent.startsWith(`---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n`)).toBe(true)
                expect(generatedContent).toContain(skill.content)
            }
        })
    })
})

describe("cleanupLearnedSkills", () => {
    async function withTempSkillRoot<T>(fn: (agentsRoot: string) => Promise<T>): Promise<T> {
        const agentsRoot = await mkdtemp(path.join(tmpdir(), "autocode-cleanup-"))

        try {
            return await fn(agentsRoot)
        } finally {
            rmSync(agentsRoot, { recursive: true, force: true })
        }
    }

    function makeLearnedSkill(agentsRoot: string, category: string, dirName: string): string {
        const dir = path.join(agentsRoot, ".agents", "skills", `learned-${category}`, dirName)
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${dirName}\ndescription: x\n---\n\n## T\n\n- L\n\n----------\n`)
        return dir
    }

    function setMtime(agentsRoot: string, category: string, dirName: string, isoTime: string): void {
        const file = path.join(agentsRoot, ".agents", "skills", `learned-${category}`, dirName, "SKILL.md")
        const ts = new Date(isoTime).getTime()
        const tsSeconds = Math.floor(ts / 1000)
        utimesSync(file, tsSeconds, tsSeconds)
    }

    test("keeps newest N skills (by mtime) and deletes the rest when over max", async () => {
        await withTempSkillRoot(async (agentsRoot) => {
            const items = [
                { dir: "learned-corrections-oldest", mtime: "2026-01-01T00:00:00Z" },
                { dir: "learned-corrections-older", mtime: "2026-01-02T00:00:00Z" },
                { dir: "learned-corrections-middle", mtime: "2026-01-03T00:00:00Z" },
                { dir: "learned-corrections-newer", mtime: "2026-01-04T00:00:00Z" },
                { dir: "learned-corrections-newest", mtime: "2026-01-05T00:00:00Z" },
            ]
            for (const item of items) {
                makeLearnedSkill(agentsRoot, "corrections", item.dir)
                setMtime(agentsRoot, "corrections", item.dir, item.mtime)
            }

            await cleanupLearnedSkills(agentsRoot, 3)

            const remaining = readdirSync(path.join(agentsRoot, ".agents", "skills", "learned-corrections"), { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name)
                .sort()
            expect(remaining).toEqual([
                "learned-corrections-middle",
                "learned-corrections-newer",
                "learned-corrections-newest",
            ])
        })
    })

    test("default max=10 keeps all skills when fewer than 10 exist", async () => {
        await withTempSkillRoot(async (agentsRoot) => {
            for (let i = 1; i <= 8; i++) {
                const dir = `learned-env-item-${i}`
                makeLearnedSkill(agentsRoot, "env", dir)
                setMtime(agentsRoot, "env", dir, `2026-01-${String(i).padStart(2, "0")}T00:00:00Z`)
            }

            await cleanupLearnedSkills(agentsRoot, 10)

            const remaining = readdirSync(path.join(agentsRoot, ".agents", "skills", "learned-env"), { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name)
                .sort()
            expect(remaining.length).toBe(8)
        })
    })

    test("does not touch legacy skills root single-file dirs (no learned-<category> parent)", async () => {
        await withTempSkillRoot(async (agentsRoot) => {
            // Legacy pre-rewrite shape: dir directly under skills root.
            const legacyDir = path.join(agentsRoot, ".agents", "skills", "learned-corrections-pair")
            mkdirSync(legacyDir, { recursive: true })
            writeFileSync(path.join(legacyDir, "SKILL.md"), "---\nname: legacy\n---\n# Legacy\n")

            await cleanupLearnedSkills(agentsRoot, 0)

            expect(existsSync(path.join(legacyDir, "SKILL.md"))).toBe(true)
        })
    })
})

describe("cleanupLearnedSkills additional cases", () => {
    async function withTempSkillRoot<T>(fn: (agentsRoot: string) => Promise<T>): Promise<T> {
        const agentsRoot = await mkdtemp(path.join(tmpdir(), "autocode-cleanup2-"))
        try {
            return await fn(agentsRoot)
        } finally {
            rmSync(agentsRoot, { recursive: true, force: true })
        }
    }

    function makeLearnedSkill(agentsRoot: string, category: string, dirName: string): string {
        const dir = path.join(agentsRoot, ".agents", "skills", `learned-${category}`, dirName)
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${dirName}\ndescription: x\n---\n\n## T\n\n- L\n\n----------\n`)
        return dir
    }

    function setMtime(agentsRoot: string, category: string, dirName: string, isoTime: string): void {
        const file = path.join(agentsRoot, ".agents", "skills", `learned-${category}`, dirName, "SKILL.md")
        const ts = new Date(isoTime).getTime()
        const tsSeconds = Math.floor(ts / 1000)
        utimesSync(file, tsSeconds, tsSeconds)
    }

    test("skips entries without SKILL.md without deleting them", async () => {
        await withTempSkillRoot(async (agentsRoot) => {
            makeLearnedSkill(agentsRoot, "corrections", "learned-corrections-latest")
            setMtime(agentsRoot, "corrections", "learned-corrections-latest", "2026-01-05T00:00:00Z")
            makeLearnedSkill(agentsRoot, "corrections", "learned-corrections-oldest")
            setMtime(agentsRoot, "corrections", "learned-corrections-oldest", "2026-01-01T00:00:00Z")
            // Dir without SKILL.md — must be skipped, not deleted.
            mkdirSync(path.join(agentsRoot, ".agents", "skills", "learned-corrections", "in-progress-dir"), { recursive: true })

            await cleanupLearnedSkills(agentsRoot, 1)

            const remaining = readdirSync(path.join(agentsRoot, ".agents", "skills", "learned-corrections"), { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name)
                .sort()
            expect(remaining).toContain("learned-corrections-latest")
            expect(remaining).toContain("in-progress-dir")
            expect(remaining).not.toContain("learned-corrections-oldest")
        })
    })

    test("does not create learned-<category> dir when missing (no-op)", async () => {
        await withTempSkillRoot(async (agentsRoot) => {
            expect(existsSync(path.join(agentsRoot, ".agents", "skills", "learned-permissions"))).toBe(false)

            await cleanupLearnedSkills(agentsRoot, 3)

            expect(existsSync(path.join(agentsRoot, ".agents", "skills", "learned-permissions"))).toBe(false)
        })
    })

    test("falls back to default max when max is invalid and never throws", async () => {
        await withTempSkillRoot(async (agentsRoot) => {
            for (let i = 1; i <= 12; i++) {
                const dir = `learned-env-item-${i}`
                makeLearnedSkill(agentsRoot, "env", dir)
                setMtime(agentsRoot, "env", dir, `2026-01-${String(i).padStart(2, "0")}T00:00:00Z`)
            }

            await expect(cleanupLearnedSkills(agentsRoot, "oops" as never)).resolves.toBeUndefined()

            const remaining = readdirSync(path.join(agentsRoot, ".agents", "skills", "learned-env"), { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name)
                .sort()
            // Invalid max falls back to 10; only oldest 2 should be removed when 12 were created.
            expect(remaining.length).toBe(10)
        })
    })
})
