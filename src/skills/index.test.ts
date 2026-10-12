import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ensureGeneratedSkills, getGeneratedSkillsRoot, managedSkills, reconcileGeneratedSkills } from "./index"

setDefaultTimeout(30_000)

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
const legacyGitHubSkillsRelativePath = path.join(".agents", "skills", "github")

function sourceSkillsRoot(): string {
    return path.join(import.meta.dir, "..", "skills")
}

async function loadBundledSkillFixture(home: string): Promise<typeof import("./index")> {
    const root = path.join(home, "bundle", "skills")
    mkdirSync(root, { recursive: true })
    for (const directory of expectedManagedDirectories) {
        mkdirSync(path.join(root, directory), { recursive: true })
        writeFileSync(path.join(root, directory, "SKILL.md"), `---\nname: ${directory}\ndescription: Builtin fixture\n---\nBuiltin ${directory}\n`)
    }
    const referencesRoot = path.join(root, "author-agent", "references")
    mkdirSync(referencesRoot)
    writeFileSync(path.join(referencesRoot, "support.txt"), "builtin support")

    const relativeInstallPath = "github/antfu/skills/vitest"
    const snapshot = "---\nname: vitest\ndescription: GitHub fixture\n---\nGitHub snapshot\n"
    mkdirSync(path.join(root, relativeInstallPath), { recursive: true })
    writeFileSync(path.join(root, relativeInstallPath, "SKILL.md"), snapshot)
    writeFileSync(path.join(root, "github.jsonc"), JSON.stringify({ skills: [{
        sourceUrl: "https://github.com/antfu/skills/tree/main/skills/vitest",
        resolvedCommit: "a".repeat(40),
        relativeInstallPath,
        category: "test",
        sha256: createHash("sha256").update(snapshot).digest("hex"),
    }] }))

    const pathsModuleUrl = pathToFileURL(path.join(import.meta.dir, "..", "utils", "paths.ts")).href
    const source = readFileSync(path.join(import.meta.dir, "index.ts"), "utf8")
        .replace('from "@/utils/paths"', `from "${pathsModuleUrl}"`)
    const modulePath = path.join(root, "index.ts")
    writeFileSync(modulePath, source)
    return await import(pathToFileURL(modulePath).href)
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
            expect(getGeneratedSkillsRoot({ home })).not.toContain(xdgConfigHome)
            delete process.env.XDG_CONFIG_HOME
            expect(getGeneratedSkillsRoot({ home })).toBe(path.join(home, ".agents", "skills", "autocode"))
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

    test("extracts only builtins from a mixed bundle without touching GitHub or user skills", async () => {
        await withIsolatedSkillConfigHome(async (home) => {
            const fixture = await loadBundledSkillFixture(home)
            const builtinRoot = getGeneratedSkillsRoot({ home })
            const root = path.join(home, legacyGitHubSkillsRelativePath)
            const present = path.join(root, "angular", "skills", "angular-developer")
            const userSkill = path.join(home, ".agents", "skills", "user", "SKILL.md")
            mkdirSync(present, { recursive: true })
            writeFileSync(path.join(present, "SKILL.md"), "user skill")
            mkdirSync(path.dirname(userSkill), { recursive: true })
            writeFileSync(userSkill, "keep user skill")
            const warning = spyOn(console, "warn").mockImplementation((): void => {})

            try {
                const result = await fixture.reconcileGeneratedSkills({ home })

                expect(result).toEqual({
                    root: builtinRoot,
                    changedPaths: expectedManagedDirectories.map((directory) => path.join(builtinRoot, directory)),
                })
                expect(fixture.managedSkills.map((skill) => skill.directory)).toEqual(expectedManagedDirectories)
                for (const directory of expectedManagedDirectories) {
                    expect(readFileSync(path.join(builtinRoot, directory, "SKILL.md"), "utf8"))
                        .toBe(readFileSync(path.join(home, "bundle", "skills", directory, "SKILL.md"), "utf8"))
                }
                expect(readFileSync(path.join(builtinRoot, "author-agent", "references", "support.txt"), "utf8")).toBe("builtin support")
                expect(existsSync(path.join(builtinRoot, "github"))).toBe(false)
                expect(readdirSync(root)).toEqual(["angular"])
                expect(existsSync(path.join(root, "antfu", "skills", "vitest"))).toBe(false)
                expect(readFileSync(path.join(present, "SKILL.md"), "utf8")).toBe("user skill")
                expect(readFileSync(userSkill, "utf8")).toBe("keep user skill")
                expect(warning).not.toHaveBeenCalled()
            } finally {
                warning.mockRestore()
            }
        })
    })

    test.each([false, true])("ignores a missing GitHub inventory with skipExtraction=%s", async (skipExtraction: boolean): Promise<void> => {
        await withIsolatedSkillConfigHome(async (home) => {
            const fixture = await loadBundledSkillFixture(home)
            rmSync(path.join(home, "bundle", "skills", "github.jsonc"))

            const result = await fixture.reconcileGeneratedSkills({ home, skipExtraction })

            expect(result).toEqual({
                root: getGeneratedSkillsRoot({ home }),
                changedPaths: skipExtraction ? [] : expectedManagedDirectories.map((directory) => path.join(result.root, directory)),
            })
            expect(existsSync(path.join(home, legacyGitHubSkillsRelativePath))).toBe(false)
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
