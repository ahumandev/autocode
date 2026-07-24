import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import * as nodeFs from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { syncGitHubSkillInventory, type GitHubSkillGit, type GitHubSkillSyncDependencies, type GitHubSkillSyncFileSystem, type GitHubSkillSyncOptions } from "./github-sync"

const tempRoots: string[] = []
const commit = "a".repeat(40)

type Fixture = {
    root: string
    manifestPath: string
    skillsRoot: string
    cacheRoot: string
    repositories: Map<string, string>
    warnings: string[]
}

type ManifestSkill = {
    sourceUrl: string
    relativeInstallPath: string
    category?: "bash" | "code" | "design" | "test"
}

function sha256(content: string): string {
    return createHash("sha256").update(content).digest("hex")
}

function cloneUrl(sourceUrl: string): string {
    const parsed = new URL(sourceUrl)
    const parts = parsed.pathname.split("/").filter(Boolean)
    return `https://github.com/${parts[0]}/${parts[1]}.git`
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
        const filePath = join(root, path)
        await nodeFs.mkdir(dirname(filePath), { recursive: true })
        await nodeFs.writeFile(filePath, content)
    }
}

async function createFixture(skills: ManifestSkill[] = []): Promise<Fixture> {
    const root = await nodeFs.mkdtemp(join(tmpdir(), "autocode-github-sync-"))
    const fixture: Fixture = {
        root,
        manifestPath: join(root, "manifest.jsonc"),
        skillsRoot: join(root, "snapshots"),
        cacheRoot: join(root, "cache"),
        repositories: new Map(),
        warnings: [],
    }
    tempRoots.push(root)
    await nodeFs.mkdir(fixture.skillsRoot, { recursive: true })
    await writeManifest(fixture, skills)
    return fixture
}

async function writeManifest(fixture: Fixture, skills: ManifestSkill[]): Promise<void> {
    await nodeFs.writeFile(fixture.manifestPath, `${JSON.stringify({ skills: skills.map((skill) => ({
        sourceUrl: skill.sourceUrl,
        resolvedCommit: commit,
        relativeInstallPath: skill.relativeInstallPath,
        category: skill.category ?? "code",
        sha256: sha256("previous snapshot\n"),
    })) }, null, 4)}\n`)
}

async function addRepository(fixture: Fixture, sourceUrl: string, files: Record<string, string>): Promise<string> {
    const repository = join(fixture.root, "repositories", String(fixture.repositories.size))
    await writeTree(repository, files)
    fixture.repositories.set(cloneUrl(sourceUrl), repository)
    return repository
}

function options(fixture: Fixture): GitHubSkillSyncOptions {
    return {
        manifestPath: fixture.manifestPath,
        skillsRoot: fixture.skillsRoot,
        cacheRoot: fixture.cacheRoot,
        logger: { warn: (message: string): void => { fixture.warnings.push(message) } },
    }
}

function dependencies(fixture: Fixture, state: { clones: number; fetches: number } = { clones: 0, fetches: 0 }): GitHubSkillSyncDependencies & { git: GitHubSkillGit } {
    const repositories = new Set<string>()
    const git: GitHubSkillGit = {
        async isRepository(path: string): Promise<boolean> {
            return repositories.has(path)
        },
        async clone(url: string, destination: string): Promise<void> {
            const source = fixture.repositories.get(url)
            if (source === undefined) throw new Error(`missing fixture repository ${url}`)
            state.clones += 1
            await nodeFs.cp(source, destination, { recursive: true, dereference: false })
            repositories.add(destination)
        },
        async fetch(_path: string): Promise<void> {
            state.fetches += 1
        },
        async revision(_path: string): Promise<string> {
            return commit
        },
    }
    return { git }
}

function manifestSkills(inventory: { skills: { relativeInstallPath: string }[] }): string[] {
    return inventory.skills.map((skill) => skill.relativeInstallPath)
}

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(async (root) => nodeFs.rm(root, { recursive: true, force: true })))
})

describe("syncGitHubSkillInventory", () => {
    test("syncs repository, tree, blob, and raw sources with deterministic snapshots and provenance", async () => {
        const repositoryUrl = "https://github.com/acme/repository"
        const treeUrl = "https://github.com/acme/tree-repository/tree/main/selected"
        const blobUrl = "https://github.com/acme/blob-repository/blob/main/blob-skill/SKILL.md"
        const rawUrl = "https://raw.githubusercontent.com/acme/raw-repository/refs/heads/main/raw-skill/SKILL.md"
        const fixture = await createFixture([
            { sourceUrl: rawUrl, relativeInstallPath: "github/acme/raw-repository/raw-skill" },
            { sourceUrl: repositoryUrl, relativeInstallPath: "github/acme/repository/alpha" },
            { sourceUrl: blobUrl, relativeInstallPath: "github/acme/blob-repository/blob-skill" },
            { sourceUrl: treeUrl, relativeInstallPath: "github/acme/tree-repository/tree-skill" },
        ])
        await addRepository(fixture, repositoryUrl, {
            "LICENSE": "root license\n",
            "COPYING.txt": "copying\n",
            "NOTICE.md": "notice\n",
            "attribution": "credits\n",
            "alpha/SKILL.md": "alpha\n",
            "alpha/support.md": "alpha support\n",
        })
        await addRepository(fixture, treeUrl, {
            "LICENSE": "tree license\n",
            "selected/tree-skill/SKILL.md": "tree\n",
            "selected/tree-skill/examples/example.txt": "complete support\n",
            "selected/tree-skill/legal/NOTICE": "nested notice\n",
        })
        await addRepository(fixture, blobUrl, { "LICENSE": "blob license\n", "blob-skill/SKILL.md": "blob\n", "blob-skill/data.txt": "blob support\n" })
        await addRepository(fixture, rawUrl, { "LICENSE": "raw license\n", "raw-skill/SKILL.md": "raw\n", "raw-skill/data.txt": "raw support\n" })

        const result = await syncGitHubSkillInventory(options(fixture), dependencies(fixture))

        expect(manifestSkills(result.inventory)).toEqual([
            "github/acme/blob-repository/blob-skill",
            "github/acme/raw-repository/raw-skill",
            "github/acme/repository/alpha",
            "github/acme/tree-repository/tree-skill",
        ])
        expect(await nodeFs.readFile(join(fixture.skillsRoot, "acme/repository/alpha/support.md"), "utf8")).toBe("alpha support\n")
        expect(await nodeFs.readFile(join(fixture.skillsRoot, "acme/tree-repository/tree-skill/examples/example.txt"), "utf8")).toBe("complete support\n")
        expect(await nodeFs.readFile(join(fixture.skillsRoot, "acme/repository/LICENSE"), "utf8")).toBe("root license\n")
        expect(await nodeFs.readFile(join(fixture.skillsRoot, "acme/tree-repository/selected/tree-skill/legal/NOTICE"), "utf8")).toBe("nested notice\n")
        expect(existsSync(join(fixture.skillsRoot, "github/acme"))).toBe(false)
        const tree = result.inventory.skills.find((skill) => skill.relativeInstallPath.endsWith("tree-skill"))
        if (!tree) throw new Error("Expected tree skill")
        expect(tree.sha256).toBe(sha256("tree\n"))
        expect(tree.legalFiles).toEqual([
            { relativePath: "LICENSE", sha256: sha256("tree license\n") },
            { relativePath: "selected/tree-skill/legal/NOTICE", sha256: sha256("nested notice\n") },
        ])
        const repository = result.inventory.skills.find((skill) => skill.relativeInstallPath.endsWith("/alpha"))
        if (!repository) throw new Error("Expected repository skill")
        expect(repository.legalFiles?.map((file) => file.relativePath)).toEqual(["attribution", "COPYING.txt", "LICENSE", "NOTICE.md"])
        expect(fixture.warnings).toEqual([])
    })

    test("reuses valid cached repositories without destructive refresh operations", async () => {
        const sourceUrl = "https://github.com/acme/cache-repository"
        const fixture = await createFixture([{ sourceUrl, relativeInstallPath: "github/acme/cache-repository/cache-skill" }])
        await addRepository(fixture, sourceUrl, { "LICENSE": "license\n", "cache-skill/SKILL.md": "cache\n" })
        const state = { clones: 0, fetches: 0 }
        const syncDependencies = dependencies(fixture, state)
        const destructiveOperations: string[] = []
        syncDependencies.git.hardReset = async (): Promise<void> => { destructiveOperations.push("hardReset") }
        syncDependencies.git.clean = async (): Promise<void> => { destructiveOperations.push("clean") }

        await syncGitHubSkillInventory(options(fixture), syncDependencies)
        await syncGitHubSkillInventory(options(fixture), syncDependencies)

        expect(state).toEqual({ clones: 1, fetches: 2 })
        expect(destructiveOperations).toEqual([])
    })

    for (const permissionCode of ["EACCES", "EPERM"] as const) {
        test(`retries ${permissionCode} primary cache access in fallback cache`, async () => {
            const sourceUrl = `https://github.com/acme/permission-${permissionCode.toLowerCase()}`
            const fixture = await createFixture([{ sourceUrl, relativeInstallPath: `github/acme/permission-${permissionCode.toLowerCase()}/skill` }])
            const fallbackCacheRoot = join(fixture.root, "fallback-cache")
            const primaryRepository = join(fixture.cacheRoot, "acme", `permission-${permissionCode.toLowerCase()}`)
            const fallbackRepository = join(fallbackCacheRoot, "acme", `permission-${permissionCode.toLowerCase()}`)
            const clonePaths: string[] = []
            const mkdirPaths: string[] = []
            await addRepository(fixture, sourceUrl, { "LICENSE": "license\n", "skill/SKILL.md": "skill\n" })
            const syncDependencies = dependencies(fixture)
            const clone = syncDependencies.git.clone
            syncDependencies.git.clone = async (url: string, destination: string): Promise<void> => {
                clonePaths.push(destination)
                await clone(url, destination)
            }
            const fs: GitHubSkillSyncFileSystem = {
                ...nodeFs,
                async mkdir(path: string, mkdirOptions?: { recursive?: boolean }): Promise<string | undefined> {
                    mkdirPaths.push(path)
                    if (path === dirname(primaryRepository)) throw Object.assign(new Error("primary cache denied"), { code: permissionCode })
                    return nodeFs.mkdir(path, mkdirOptions)
                },
            }

            await syncGitHubSkillInventory({ ...options(fixture), fallbackCacheRoot }, { ...syncDependencies, fs })

            expect(clonePaths).toEqual([fallbackRepository])
            expect(mkdirPaths).toContain(dirname(primaryRepository))
            expect(mkdirPaths).toContain(dirname(fallbackRepository))
            expect(existsSync(primaryRepository)).toBe(false)
            expect(await nodeFs.readFile(join(fallbackRepository, "skill/SKILL.md"), "utf8")).toBe("skill\n")
        })
    }

    test("reuses fallback cache and force refreshes it after primary access is denied", async () => {
        const sourceUrl = "https://github.com/acme/fallback-repository"
        const fixture = await createFixture([{ sourceUrl, relativeInstallPath: "github/acme/fallback-repository/skill" }])
        const fallbackCacheRoot = join(fixture.root, "fallback-cache")
        const primaryRepository = join(fixture.cacheRoot, "acme", "fallback-repository")
        const fallbackRepository = join(fallbackCacheRoot, "acme", "fallback-repository")
        const state = { clones: 0, fetches: 0 }
        const operations: string[] = []
        const clonePaths: string[] = []
        await addRepository(fixture, sourceUrl, { "LICENSE": "license\n", "skill/SKILL.md": "skill\n" })
        const syncDependencies = dependencies(fixture, state)
        const clone = syncDependencies.git.clone
        syncDependencies.git.clone = async (url: string, destination: string): Promise<void> => {
            clonePaths.push(destination)
            await clone(url, destination)
        }
        syncDependencies.git.fetch = async (path: string): Promise<void> => {
            operations.push(`fetch:${path}`)
            state.fetches += 1
        }
        syncDependencies.git.fetchRemote = async (path: string): Promise<void> => { operations.push(`fetchRemote:${path}`) }
        syncDependencies.git.remoteDefaultBranch = async (path: string): Promise<string> => {
            operations.push(`remoteDefaultBranch:${path}`)
            return "main"
        }
        syncDependencies.git.checkout = async (path: string, revision: string): Promise<void> => { operations.push(`checkout:${path}:${revision}`) }
        syncDependencies.git.hardReset = async (path: string, revision: string): Promise<void> => { operations.push(`hardReset:${path}:${revision}`) }
        syncDependencies.git.clean = async (path: string): Promise<void> => { operations.push(`clean:${path}`) }
        const fs: GitHubSkillSyncFileSystem = {
            ...nodeFs,
            async mkdir(path: string, mkdirOptions?: { recursive?: boolean }): Promise<string | undefined> {
                if (path === dirname(primaryRepository)) throw Object.assign(new Error("primary cache denied"), { code: "EACCES" })
                return nodeFs.mkdir(path, mkdirOptions)
            },
        }

        await syncGitHubSkillInventory({ ...options(fixture), fallbackCacheRoot }, { ...syncDependencies, fs })
        await syncGitHubSkillInventory({ ...options(fixture), fallbackCacheRoot }, { ...syncDependencies, fs })
        await syncGitHubSkillInventory({ ...options(fixture), fallbackCacheRoot, forceRefresh: true }, { ...syncDependencies, fs })

        expect(state).toEqual({ clones: 1, fetches: 2 })
        expect(clonePaths).toEqual([fallbackRepository])
        expect(operations).toEqual([
            `fetch:${fallbackRepository}`,
            `fetch:${fallbackRepository}`,
            `fetchRemote:${fallbackRepository}`,
            `remoteDefaultBranch:${fallbackRepository}`,
            `checkout:${fallbackRepository}:origin/main`,
            `hardReset:${fallbackRepository}:origin/main`,
            `clean:${fallbackRepository}`,
        ])
    })

    test("does not retry in fallback cache after a non-permission primary failure", async () => {
        const sourceUrl = "https://github.com/acme/primary-failure"
        const fixture = await createFixture([{ sourceUrl, relativeInstallPath: "github/acme/primary-failure/skill" }])
        const fallbackCacheRoot = join(fixture.root, "fallback-cache")
        const primaryRepository = join(fixture.cacheRoot, "acme", "primary-failure")
        const clonePaths: string[] = []
        const mkdirPaths: string[] = []
        const syncDependencies = dependencies(fixture)
        syncDependencies.git.clone = async (_url: string, destination: string): Promise<void> => { clonePaths.push(destination) }
        const fs: GitHubSkillSyncFileSystem = {
                ...nodeFs,
                async mkdir(path: string, mkdirOptions?: { recursive?: boolean }): Promise<string | undefined> {
                    mkdirPaths.push(path)
                    if (path === dirname(primaryRepository)) throw new Error("primary cache failure")
                    return nodeFs.mkdir(path, mkdirOptions)
            },
        }

        await expect(syncGitHubSkillInventory({ ...options(fixture), fallbackCacheRoot }, { ...syncDependencies, fs })).rejects.toThrow("primary cache failure")

        expect(clonePaths).toEqual([])
        expect(mkdirPaths).toEqual([dirname(primaryRepository)])
        expect(existsSync(join(fallbackCacheRoot, "acme", "primary-failure"))).toBe(false)
    })

    test("does not retry Git network failures in fallback cache", async () => {
        const sourceUrl = "https://github.com/acme/network-failure"
        const fixture = await createFixture([{ sourceUrl, relativeInstallPath: "github/acme/network-failure/skill" }])
        const fallbackCacheRoot = join(fixture.root, "fallback-cache")
        const primaryRepository = join(fixture.cacheRoot, "acme", "network-failure")
        const fallbackRepository = join(fallbackCacheRoot, "acme", "network-failure")
        const clonePaths: string[] = []
        const syncDependencies = dependencies(fixture)
        syncDependencies.git.clone = async (_url: string, destination: string): Promise<void> => {
            clonePaths.push(destination)
            throw new Error("network unavailable")
        }

        await expect(syncGitHubSkillInventory({ ...options(fixture), fallbackCacheRoot }, syncDependencies)).rejects.toThrow("network unavailable")

        expect(clonePaths).toEqual([primaryRepository])
        expect(existsSync(fallbackRepository)).toBe(false)
    })

    test("does not retry an invalid primary cache in fallback cache", async () => {
        const sourceUrl = "https://github.com/acme/invalid-cache"
        const fixture = await createFixture([{ sourceUrl, relativeInstallPath: "github/acme/invalid-cache/skill" }])
        const fallbackCacheRoot = join(fixture.root, "fallback-cache")
        const primaryRepository = join(fixture.cacheRoot, "acme", "invalid-cache")
        const fallbackRepository = join(fallbackCacheRoot, "acme", "invalid-cache")
        const clonePaths: string[] = []
        await addRepository(fixture, sourceUrl, { "LICENSE": "license\n", "skill/SKILL.md": "skill\n" })
        const syncDependencies = dependencies(fixture)
        const clone = syncDependencies.git.clone
        syncDependencies.git.clone = async (url: string, destination: string): Promise<void> => {
            clonePaths.push(destination)
            await clone(url, destination)
        }
        syncDependencies.git.isRepository = async (): Promise<boolean> => false

        await expect(syncGitHubSkillInventory({ ...options(fixture), fallbackCacheRoot }, syncDependencies)).rejects.toThrow(`clone ${primaryRepository} is not a Git repository`)

        expect(clonePaths).toEqual([primaryRepository])
        expect(existsSync(fallbackRepository)).toBe(false)
    })

    test("does not retry malformed inventory in fallback cache", async () => {
        const fixture = await createFixture()
        const fallbackCacheRoot = join(fixture.root, "fallback-cache")
        const clonePaths: string[] = []
        const syncDependencies = dependencies(fixture)
        syncDependencies.git.clone = async (_url: string, destination: string): Promise<void> => { clonePaths.push(destination) }
        await nodeFs.writeFile(fixture.manifestPath, "{\n")

        await expect(syncGitHubSkillInventory({ ...options(fixture), fallbackCacheRoot }, syncDependencies)).rejects.toThrow("malformed JSONC")

        expect(clonePaths).toEqual([])
        expect(existsSync(fallbackCacheRoot)).toBe(false)
    })

    test("force refresh replaces stale cached repository content from its remote branch", async () => {
        const sourceUrl = "https://github.com/acme/forced-repository"
        const remoteCommit = "b".repeat(40)
        const fixture = await createFixture([{ sourceUrl, relativeInstallPath: "github/acme/forced-repository/forced-skill" }])
        const remoteRepository = await addRepository(fixture, sourceUrl, { "LICENSE": "license\n", "forced-skill/SKILL.md": "stale skill\n" })
        const state = { clones: 0, fetches: 0 }
        const syncDependencies = dependencies(fixture, state)

        await syncGitHubSkillInventory(options(fixture), syncDependencies)
        await writeTree(remoteRepository, { "forced-skill/SKILL.md": "remote skill\n" })

        const operations: string[] = []
        syncDependencies.git.fetchRemote = async (path: string): Promise<void> => {
            operations.push("fetchRemote")
            await nodeFs.rm(path, { recursive: true, force: true })
            await nodeFs.cp(remoteRepository, path, { recursive: true, dereference: false })
        }
        syncDependencies.git.remoteDefaultBranch = async (): Promise<string> => {
            operations.push("remoteDefaultBranch")
            return "main"
        }
        syncDependencies.git.checkout = async (_path: string, revision: string): Promise<void> => { operations.push(`checkout:${revision}`) }
        syncDependencies.git.hardReset = async (_path: string, revision: string): Promise<void> => { operations.push(`hardReset:${revision}`) }
        syncDependencies.git.clean = async (): Promise<void> => { operations.push("clean") }
        syncDependencies.git.revision = async (): Promise<string> => {
            operations.push("revision")
            return remoteCommit
        }
        const fs: GitHubSkillSyncFileSystem = {
            ...nodeFs,
            async readdir(path: string): Promise<string[]> {
                if (path.startsWith(join(fixture.cacheRoot, "acme", "forced-repository"))) operations.push("sourceScan")
                return nodeFs.readdir(path)
            },
        }

        const result = await syncGitHubSkillInventory({ ...options(fixture), forceRefresh: true }, { ...syncDependencies, fs })

        expect(state.clones).toBe(1)
        expect(operations.slice(0, 6)).toEqual([
            "fetchRemote",
            "remoteDefaultBranch",
            "checkout:origin/main",
            "hardReset:origin/main",
            "clean",
            "revision",
        ])
        expect(operations.indexOf("sourceScan")).toBeGreaterThan(operations.indexOf("clean"))
        expect(await nodeFs.readFile(join(fixture.skillsRoot, "acme/forced-repository/forced-skill/SKILL.md"), "utf8")).toBe("remote skill\n")
        expect(result.inventory.skills).toEqual([expect.objectContaining({
            relativeInstallPath: "github/acme/forced-repository/forced-skill",
            resolvedCommit: remoteCommit,
            sha256: sha256("remote skill\n"),
        })])
    })

    test("keeps snapshots and manifest unchanged when forced refresh fails", async () => {
        const sourceUrl = "https://github.com/acme/forced-rollback"
        const fixture = await createFixture([{ sourceUrl, relativeInstallPath: "github/acme/forced-rollback/skill" }])
        await addRepository(fixture, sourceUrl, { "LICENSE": "license\n", "skill/SKILL.md": "old snapshot\n" })
        const syncDependencies = dependencies(fixture)
        await syncGitHubSkillInventory(options(fixture), syncDependencies)
        const oldSnapshot = await nodeFs.readFile(join(fixture.skillsRoot, "acme/forced-rollback/skill/SKILL.md"))
        const oldManifest = await nodeFs.readFile(fixture.manifestPath)
        syncDependencies.git.fetchRemote = async (): Promise<void> => {}
        syncDependencies.git.remoteDefaultBranch = async (): Promise<string> => "main"
        syncDependencies.git.checkout = async (): Promise<void> => {}
        syncDependencies.git.hardReset = async (): Promise<void> => { throw new Error("forced reset failure") }
        syncDependencies.git.clean = async (): Promise<void> => {}

        await expect(syncGitHubSkillInventory({ ...options(fixture), forceRefresh: true }, syncDependencies)).rejects.toThrow("forced reset failure")

        expect(await nodeFs.readFile(join(fixture.skillsRoot, "acme/forced-rollback/skill/SKILL.md"))).toEqual(oldSnapshot)
        expect(await nodeFs.readFile(fixture.manifestPath)).toEqual(oldManifest)
    })

    test("rejects duplicate install destinations, duplicate skill names, and unsafe source paths", async () => {
        const duplicate = await createFixture([
            { sourceUrl: "https://github.com/acme/duplicate", relativeInstallPath: "github/acme/duplicate/same" },
            { sourceUrl: "https://github.com/acme/duplicate", relativeInstallPath: "github/acme/duplicate/same" },
        ])
        const collision = await createFixture([
            { sourceUrl: "https://github.com/acme/one", relativeInstallPath: "github/acme/one/shared" },
            { sourceUrl: "https://github.com/acme/two", relativeInstallPath: "github/acme/two/shared" },
        ])
        await addRepository(collision, "https://github.com/acme/one", { "LICENSE": "one\n", "shared/SKILL.md": "one\n" })
        await addRepository(collision, "https://github.com/acme/two", { "LICENSE": "two\n", "shared/SKILL.md": "two\n" })
        const traversal = await createFixture([{ sourceUrl: "https://github.com/acme/escape/tree/main/../outside", relativeInstallPath: "github/acme/escape/outside" }])
        const fallbackCacheRoot = join(duplicate.root, "fallback-cache")
        await addRepository(traversal, "https://github.com/acme/escape/tree/main/../outside", { "outside/SKILL.md": "outside\n" })

        await expect(syncGitHubSkillInventory({ ...options(duplicate), fallbackCacheRoot }, dependencies(duplicate))).rejects.toThrow('duplicate relativeInstallPath "github/acme/duplicate/same"')
        expect(existsSync(fallbackCacheRoot)).toBe(false)
        await expect(syncGitHubSkillInventory(options(collision), dependencies(collision))).rejects.toThrow('duplicate or unsafe skill name "shared"')
        await expect(syncGitHubSkillInventory(options(traversal), dependencies(traversal))).rejects.toThrow("unsafe source path")
    })

    test("rejects external symlinks and missing or malformed skill files", async () => {
        const symlinkUrl = "https://github.com/acme/symlink"
        const missingUrl = "https://github.com/acme/missing"
        const emptyUrl = "https://github.com/acme/empty"
        const symlink = await createFixture([{ sourceUrl: symlinkUrl, relativeInstallPath: "github/acme/symlink/linked" }])
        const symlinkRepository = await addRepository(symlink, symlinkUrl, { "LICENSE": "license\n" })
        const outside = join(symlink.root, "outside.txt")
        await nodeFs.writeFile(outside, "outside\n")
        await nodeFs.mkdir(join(symlinkRepository, "linked"), { recursive: true })
        await nodeFs.writeFile(join(symlinkRepository, "linked", "SKILL.md"), "linked\n")
        await nodeFs.symlink(outside, join(symlinkRepository, "linked", "outside-link"))
        const missing = await createFixture([{ sourceUrl: missingUrl, relativeInstallPath: "github/acme/missing/missing" }])
        await addRepository(missing, missingUrl, { "LICENSE": "license\n", "other/file.txt": "none\n" })
        const empty = await createFixture([{ sourceUrl: emptyUrl, relativeInstallPath: "github/acme/empty/empty" }])
        await addRepository(empty, emptyUrl, { "LICENSE": "license\n", "empty/SKILL.md": "" })

        await expect(syncGitHubSkillInventory(options(symlink), dependencies(symlink))).rejects.toThrow("external symlink rejected")
        await expect(syncGitHubSkillInventory(options(missing), dependencies(missing))).rejects.toThrow("no SKILL.md found")
        await expect(syncGitHubSkillInventory(options(empty), dependencies(empty))).rejects.toThrow("malformed SKILL.md")
    })

    test("rolls back snapshots and manifest when replacement fails after a later global step", async () => {
        const sourceUrl = "https://github.com/acme/rollback"
        const fixture = await createFixture([{ sourceUrl, relativeInstallPath: "github/acme/rollback/skill" }])
        await addRepository(fixture, sourceUrl, { "LICENSE": "license\n", "skill/SKILL.md": "new snapshot\n" })
        await writeTree(fixture.skillsRoot, { "old/SKILL.md": "old snapshot\n" })
        const oldManifest = await nodeFs.readFile(fixture.manifestPath, "utf8")
        const fs: GitHubSkillSyncFileSystem = {
            ...nodeFs,
            async rename(oldPath: string, newPath: string): Promise<void> {
                if (oldPath.includes(".staging-")) throw new Error("late manifest replacement failure")
                await nodeFs.rename(oldPath, newPath)
            },
        }

        await expect(syncGitHubSkillInventory(options(fixture), { ...dependencies(fixture), fs })).rejects.toThrow("late manifest replacement failure")

        expect(await nodeFs.readFile(join(fixture.skillsRoot, "old/SKILL.md"), "utf8")).toBe("old snapshot\n")
        expect(await nodeFs.readFile(fixture.manifestPath, "utf8")).toBe(oldManifest)
    })

    test("warns once only when repository-root legal files are absent and ignores user config", async () => {
        const sourceUrl = "https://github.com/acme/no-license"
        const fixture = await createFixture([{ sourceUrl, relativeInstallPath: "github/acme/no-license/skill" }])
        await addRepository(fixture, sourceUrl, { "skill/SKILL.md": "skill\n" })
        const userConfig = join(fixture.root, "user", "opencode.jsonc")
        await writeTree(fixture.root, { "user/opencode.jsonc": "{\"private\":true}\n" })

        await syncGitHubSkillInventory(options(fixture), dependencies(fixture))

        expect(fixture.warnings).toEqual(["GitHub skill sync: acme/no-license has no repository-root license"])
        expect(await nodeFs.readFile(userConfig, "utf8")).toBe("{\"private\":true}\n")
        expect(existsSync(userConfig)).toBe(true)
    })
})
