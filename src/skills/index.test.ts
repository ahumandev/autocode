import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, utimesSync } from "fs"
import { mkdtemp } from "fs/promises"
import { homedir, tmpdir } from "os"
import path from "path"
import { cleanupLearnedSkills, ensureGeneratedSkills, getGeneratedSkillsRoot, managedSkills, reconcileGeneratedSkills } from "./index"

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

                expect(generatedContent).toBe(readFileSync(path.join(sourceSkillsRoot(), skill.directory, "SKILL.md"), "utf8"))
            }
        })
    })
})

describe("generated skill reconciliation", () => {
    function statePath(root: string): string {
        return path.join(root, "skills.jsonc")
    }

    function readState(root: string): { items: Record<string, { sha256: string }> } {
        return JSON.parse(readFileSync(statePath(root), "utf8"))
    }

    function writeState(root: string, state: { items: Record<string, { sha256: string }> }): void {
        writeFileSync(statePath(root), JSON.stringify(state))
    }

    test("uses XDG config root or HOME agents fallback", async () => {
        await withIsolatedSkillConfigHome(async (_home, xdgConfigHome) => {
            expect(getGeneratedSkillsRoot()).toBe(path.join(xdgConfigHome, "skills", "autocode"))
            delete process.env.XDG_CONFIG_HOME
            expect(getGeneratedSkillsRoot()).toBe(path.join(homedir(), ".agents", "skills", "autocode"))
        })
    })

    test("skips unchanged items using recorded SHA-256 state", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const root = (await reconcileGeneratedSkills()).root
            const before = readFileSync(path.join(root, "author-agent", "SKILL.md"), "utf8")

            const result = await reconcileGeneratedSkills()

            expect(result.changedPaths).toEqual([])
            expect(readFileSync(path.join(root, "author-agent", "SKILL.md"), "utf8")).toBe(before)
        })
    })

    test("copies a missing destination even when state records its SHA-256", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const root = (await reconcileGeneratedSkills()).root
            const destination = path.join(root, "author-agent")
            rmSync(destination, { recursive: true })

            const result = await reconcileGeneratedSkills()

            expect(result.changedPaths).toContain(destination)
            expect(readFileSync(path.join(destination, "SKILL.md"), "utf8")).toContain(managedSkills.find((skill) => skill.directory === "author-agent")!.content)
        })
    })

    test("updates only changed state item while unchanged destinations stay untouched", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const root = (await reconcileGeneratedSkills()).root
            const state = readState(root)
            const untouched = path.join(root, "author-command", "SKILL.md")
            const untouchedContent = readFileSync(untouched, "utf8")
            state.items["author-agent"] = { sha256: "stale" }
            writeState(root, state)

            const result = await reconcileGeneratedSkills()

            expect(result.changedPaths).toEqual([path.join(root, "author-agent")])
            expect(readFileSync(untouched, "utf8")).toBe(untouchedContent)
            expect(readState(root).items["author-agent"]?.sha256).not.toBe("stale")
        })
    })

    test("removes destination and state for removed managed item", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const root = (await reconcileGeneratedSkills()).root
            const removed = path.join(root, "removed-skill")
            mkdirSync(removed)
            writeFileSync(path.join(removed, "SKILL.md"), "old")
            const state = readState(root)
            state.items["removed-skill"] = { sha256: "old" }
            writeState(root, state)

            const result = await reconcileGeneratedSkills()

            expect(result.changedPaths).toContain(removed)
            expect(existsSync(removed)).toBe(false)
            expect(readState(root).items["removed-skill"]).toBeUndefined()
        })
    })

    test("migrates legacy GitHub symlink destination to real directory", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const root = (await reconcileGeneratedSkills()).root
            const destination = path.join(root, "github", "angular", "skills")
            rmSync(destination, { recursive: true })
            symlinkSync(path.join(root, "author-agent"), destination, "dir")

            const result = await reconcileGeneratedSkills()

            expect(result.changedPaths).toContain(destination)
            expect(lstatSync(destination).isSymbolicLink()).toBe(false)
            expect(existsSync(path.join(destination, "angular-developer", "SKILL.md"))).toBe(true)
        })
    })

    test("extracts, updates, and removes a repository legal file with reconciled state", async () => {
        const repositoryPath = "github/antfu/skills"
        const legalFile = "LICENSE.md"
        const legalPath = `${repositoryPath}/${legalFile}`

        await withIsolatedSkillConfigHome(async () => {
            const initial = await reconcileGeneratedSkills()
            const destination = path.join(initial.root, repositoryPath)
            const generatedLegalPath = path.join(destination, legalFile)
            const legalContent = readFileSync(generatedLegalPath, "utf8")
            const initialDigest = readState(initial.root).items[repositoryPath]!.sha256

            expect(initial.changedPaths).toContain(destination)
            expect(initialDigest).toMatch(/^[a-f0-9]{64}$/)

            writeFileSync(generatedLegalPath, "previous bundle legal content")
            const updateState = readState(initial.root)
            updateState.items[repositoryPath] = { sha256: "stale" }
            writeState(initial.root, updateState)

            const updated = await reconcileGeneratedSkills()

            expect(updated.changedPaths).toContain(destination)
            expect(readFileSync(generatedLegalPath, "utf8")).toBe(legalContent)
            expect(readState(updated.root).items[repositoryPath]?.sha256).toBe(initialDigest)

            const removalState = readState(updated.root)
            removalState.items[legalPath] = { sha256: "removed bundle legal file" }
            writeState(updated.root, removalState)

            const removed = await reconcileGeneratedSkills()

            expect(removed.changedPaths).toContain(generatedLegalPath)
            expect(existsSync(generatedLegalPath)).toBe(false)
            expect(readState(removed.root).items[legalPath]).toBeUndefined()
        })
    })

    test("recovers corrupt state by replacing destinations and writing valid SHA-256 state", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const root = (await reconcileGeneratedSkills()).root
            writeFileSync(statePath(root), "not json")

            const result = await reconcileGeneratedSkills()
            const state = readState(root)

            expect(result.changedPaths).toContain(path.join(root, "author-agent"))
            expect(readFileSync(path.join(root, "author-agent", "SKILL.md"), "utf8").length).toBeGreaterThan(0)
            expect(state.items["author-agent"]?.sha256).toMatch(/^[a-f0-9]{64}$/)
        })
    })

    test("writes complete state atomically without temporary state files", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const root = (await reconcileGeneratedSkills()).root
            const state = readState(root)
            const unchangedDigest = state.items["author-command"]!.sha256
            state.items["author-agent"] = { sha256: "stale" }
            writeState(root, state)

            await reconcileGeneratedSkills()

            expect(readState(root).items["author-command"]?.sha256).toBe(unchangedDigest)
            expect(readState(root).items["author-agent"]?.sha256).toMatch(/^[a-f0-9]{64}$/)
            expect(readdirSync(root).some((entry) => entry.startsWith("skills.jsonc.tmp-"))).toBe(false)
        })
    })

    test("keeps failed item state and destination while logging isolated extraction failure", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const root = (await reconcileGeneratedSkills()).root
            const state = readState(root)
            const githubRoot = path.join(root, "github")
            rmSync(githubRoot, { recursive: true })
            writeFileSync(githubRoot, "prior destination")
            state.items["github/angular/skills"] = { sha256: "prior-state" }
            writeState(root, state)
            const warnings: string[] = []
            const warn = console.warn
            console.warn = (message: string): void => { warnings.push(message) }

            try {
                await reconcileGeneratedSkills()
            } finally {
                console.warn = warn
            }

            expect(readFileSync(githubRoot, "utf8")).toBe("prior destination")
            expect(readState(root).items["github/angular/skills"]?.sha256).toBe("prior-state")
            expect(warnings.some((message) => message.includes("github/angular/skills"))).toBe(true)
        })
    })

    test("updates and removes legal root files with state", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const root = (await reconcileGeneratedSkills()).root
            const inventory = path.join(root, "github.jsonc")
            const obsolete = path.join(root, "obsolete.jsonc")
            writeFileSync(inventory, "old inventory")
            writeFileSync(obsolete, "obsolete")
            const state = readState(root)
            state.items["github.jsonc"] = { sha256: "stale" }
            state.items["obsolete.jsonc"] = { sha256: "obsolete" }
            writeState(root, state)

            const result = await reconcileGeneratedSkills()

            expect(result.changedPaths).toContain(inventory)
            expect(result.changedPaths).toContain(obsolete)
            expect(readFileSync(inventory, "utf8")).toContain('"skills"')
            expect(existsSync(obsolete)).toBe(false)
            expect(readState(root).items["obsolete.jsonc"]).toBeUndefined()
        })
    })

    test("skipExtraction returns generated root without creating or changing it", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const expectedRoot = getGeneratedSkillsRoot()
            const result = await reconcileGeneratedSkills({ skipExtraction: true })

            expect(result.root).toBe(expectedRoot)
            expect(result.changedPaths).toEqual([])
            expect(existsSync(result.root)).toBe(false)
        })
    })

    test("skipExtraction preserves an existing generated root without state writes", async () => {
        await withIsolatedSkillConfigHome(async () => {
            const root = getGeneratedSkillsRoot()
            const existingSkill = path.join(root, "existing", "SKILL.md")
            mkdirSync(path.dirname(existingSkill), { recursive: true })
            writeFileSync(existingSkill, "existing skill")

            const result = await reconcileGeneratedSkills({ skipExtraction: true })

            expect(result.root).toBe(root)
            expect(result.changedPaths).toEqual([])
            expect(readFileSync(existingSkill, "utf8")).toBe("existing skill")
            expect(existsSync(statePath(root))).toBe(false)
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
