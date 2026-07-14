import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "fs"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { ensureGeneratedSkills, getGeneratedSkillsRoot, managedSkills } from "./index"

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
    "test-jest",
    "test-junit",
    "test-mockito",
    "test-vitest",
]
const intentionalSourceExclusions = ["author-caveman"]
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
        const sourceDirectories = sourceSkillDirectories()

        expect(managedDirectories).toEqual(expectedManagedDirectories)
        expect(managedDirectories).toContain("author-skill")
        expect(sourceDirectories.filter((directory) => !managedDirectories.includes(directory))).toEqual(intentionalSourceExclusions)
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
