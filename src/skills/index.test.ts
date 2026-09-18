import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensureGeneratedSkills, getGeneratedGitHubSkillsRoot, getGeneratedSkillsRoot, managedSkills, reconcileGeneratedSkills } from "./index"

const expectedManagedDirectories = [
    "assist-troubleshoot",
    "author-agent",
    "author-article",
    "author-command",
    "author-fallacies",
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

async function withIsolatedSkillConfigHome<T>(fn: (home: string, xdgConfigHome: string) => Promise<T>): Promise<T> {
    const home = await mkdtemp(path.join(tmpdir(), "autocode-skills-home-"))
    const xdgConfigHome = await mkdtemp(path.join(tmpdir(), "autocode-skills-xdg-"))
    tempRoots.push(home)
    tempRoots.push(xdgConfigHome)

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

    test("gitignore ignores active and archived memories with anchored rules", () => {
        const gitignoreLines = readFileSync(path.join(import.meta.dir, "..", "..", ".gitignore"), "utf8").split(/\r?\n/)

        expect(gitignoreLines).toContain("/.opencode/autocode/memories/")
    })

    test("ensureGeneratedSkills writes all managed skills under home agents root despite XDG config", async () => {
        await withIsolatedSkillConfigHome(async (home, xdgConfigHome) => {
            const expectedRoot = path.join(home, ".agents", "skills", "autocode")

            expect(getGeneratedSkillsRoot({ home })).toBe(expectedRoot)
            expect(getGeneratedSkillsRoot({ home })).not.toContain(xdgConfigHome)

            const generatedRoot = await ensureGeneratedSkills({ home })

            expect(generatedRoot).toBe(expectedRoot)
            expect(existsSync(path.join(generatedRoot, "skill-write", "SKILL.md"))).toBe(true)

            for (const skill of managedSkills) {
                const generatedSkillPath = path.join(generatedRoot, skill.directory, "SKILL.md")
                const generatedContent = readFileSync(generatedSkillPath, "utf8")

                expect(generatedContent).toBe(readFileSync(path.join(sourceSkillsRoot(), skill.directory, "SKILL.md"), "utf8"))
            }
        })
    })
})

describe("generated skill reconciliation", () => {
    test("uses HOME agents root regardless of XDG config", async () => {
        await withIsolatedSkillConfigHome(async (home, xdgConfigHome) => {
            expect(getGeneratedSkillsRoot({ home })).toBe(path.join(home, ".agents", "skills", "autocode"))
            expect(getGeneratedGitHubSkillsRoot({ home })).toBe(path.join(home, ".agents", "skills", "github"))
            expect(getGeneratedSkillsRoot({ home })).not.toContain(xdgConfigHome)
            delete process.env.XDG_CONFIG_HOME
            expect(getGeneratedSkillsRoot({ home })).toBe(path.join(home, ".agents", "skills", "autocode"))
            expect(getGeneratedGitHubSkillsRoot({ home })).toBe(path.join(home, ".agents", "skills", "github"))
        })
    })

    test("skips a present skill root", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const root = getGeneratedSkillsRoot()
            const destination = path.join(root, "author-agent")
            mkdirSync(destination, { recursive: true })
            writeFileSync(path.join(destination, "SKILL.md"), "user skill")

            const result = await reconcileGeneratedSkills()

            expect(result.changedPaths).not.toContain(destination)
            expect(readFileSync(path.join(destination, "SKILL.md"), "utf8")).toBe("user skill")
        })
    })

    test("extracts each missing GitHub skill root independently", async () => {
        await withIsolatedSkillConfigHome(async (home) => {
            const root = getGeneratedGitHubSkillsRoot({ home })
            const present = path.join(root, "angular", "skills", "angular-developer")
            const missing = path.join(root, "angular", "skills", "angular-new-app")
            mkdirSync(present, { recursive: true })
            writeFileSync(path.join(present, "SKILL.md"), "user skill")

            const result = await reconcileGeneratedSkills({ home })

            expect(result.changedPaths).toContain(missing)
            expect(readFileSync(path.join(missing, "SKILL.md"), "utf8")).toContain("angular-new-app")
            expect(readFileSync(path.join(present, "SKILL.md"), "utf8")).toBe("user skill")
        })
    })

    test("skips a present skill root missing SKILL.md", async () => {
        await withIsolatedSkillConfigHome(async (home) => {
            const root = getGeneratedSkillsRoot({ home })
            const destination = path.join(root, "author-agent")
            mkdirSync(destination, { recursive: true })
            writeFileSync(path.join(destination, "user-file"), "keep")

            const result = await reconcileGeneratedSkills({ home })

            expect(result.changedPaths).not.toContain(destination)
            expect(existsSync(path.join(destination, "SKILL.md"))).toBe(false)
            expect(readFileSync(path.join(destination, "user-file"), "utf8")).toBe("keep")
        })
    })

    test("skipExtraction returns generated root without creating or changing it", async () => {
        await withIsolatedSkillConfigHome(async (home) => {
            const expectedRoot = getGeneratedSkillsRoot({ home })
            const result = await reconcileGeneratedSkills({ skipExtraction: true, home })

            expect(result.root).toBe(expectedRoot)
            expect(result.changedPaths).toEqual([])
            expect(existsSync(result.root)).toBe(false)
        })
    })

    test("skipExtraction preserves an existing generated root", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const root = getGeneratedSkillsRoot()
            const existingSkill = path.join(root, "existing", "SKILL.md")
            mkdirSync(path.dirname(existingSkill), { recursive: true })
            writeFileSync(existingSkill, "existing skill")

            const result = await reconcileGeneratedSkills({ skipExtraction: true })

            expect(result.root).toBe(root)
            expect(result.changedPaths).toEqual([])
            expect(readFileSync(existingSkill, "utf8")).toBe("existing skill")
        })
    })
})
