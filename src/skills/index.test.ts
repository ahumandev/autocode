import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { cleanupLearnedSkills, ensureGeneratedSkills, getGeneratedSkillsRoot, managedSkills } from "./index"

const expectedManagedDirectories = [
    "author-agent",
    "author-article",
    "author-command",
    "author-readme",
    "author-rules",
    "author-skill",
    "code-java",
    "code-rest",
    "code-typescript",
    "execute-sandbox",
    "git-commit",
    "primary-manual",
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
        expect(managedDirectories).toContain("author-skill")
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
            expect(existsSync(path.join(generatedRoot, "author-skill", "SKILL.md"))).toBe(true)

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

    test("keeps newest N skills and deletes the rest when over max", async () => {
        await withTempSkillRoot(async (agentsRoot) => {
            // Create t1..t5 ascending by timestamp; expect t3, t4, t5 to remain (newest 3).
            const timestamps = [
                "26-01-01-00-00-00",
                "26-01-02-00-00-00",
                "26-01-03-00-00-00",
                "26-01-04-00-00-00",
                "26-01-05-00-00-00",
            ]
            const expectedKept = timestamps.slice(2).map((ts) => `learned-corrections-${ts}-topic`)
            for (const ts of timestamps) {
                makeLearnedSkill(agentsRoot, "corrections", `learned-corrections-${ts}-topic`)
            }

            await cleanupLearnedSkills(agentsRoot, 3)

            const remaining = readdirSync(path.join(agentsRoot, ".agents", "skills", "learned-corrections"), { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name)
                .sort()
            expect(remaining).toEqual(expectedKept)
        })
    })

    test("default max=10 keeps all skills when fewer than 10 exist", async () => {
        await withTempSkillRoot(async (agentsRoot) => {
            for (let i = 1; i <= 8; i++) {
                const ts = `26-01-${String(i).padStart(2, "0")}-00-00-00`
                makeLearnedSkill(agentsRoot, "env", `learned-env-${ts}-item`)
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

    test("skips non-matching entries under learned-<category>/ without deleting them", async () => {
        await withTempSkillRoot(async (agentsRoot) => {
            makeLearnedSkill(agentsRoot, "corrections", "learned-corrections-26-01-05-00-00-00-latest")
            makeLearnedSkill(agentsRoot, "corrections", "learned-corrections-26-01-01-00-00-00-oldest")
            makeLearnedSkill(agentsRoot, "corrections", "random-no-timestamp-dir")

            await cleanupLearnedSkills(agentsRoot, 1)

            const remaining = readdirSync(path.join(agentsRoot, ".agents", "skills", "learned-corrections"), { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name)
                .sort()
            expect(remaining).toContain("learned-corrections-26-01-05-00-00-00-latest")
            expect(remaining).toContain("random-no-timestamp-dir")
            expect(remaining).not.toContain("learned-corrections-26-01-01-00-00-00-oldest")
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
                const ts = `26-01-${String(i).padStart(2, "0")}-00-00-00`
                makeLearnedSkill(agentsRoot, "env", `learned-env-${ts}-item`)
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
