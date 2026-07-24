import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { cloneUrlFor, parseGitHubSkillUrl, type ParsedGitHubSkillUrl } from "@/utils/github"
import {
    type GitHubSkillCategory,
    type GitHubSkillInventory,
    type GitHubSkillInventoryEntry,
    type GitHubSkillLegalFile,
    validateGitHubSkillInventory,
} from "@/skills/github"

const executeFile = promisify(execFile)
const LEGAL_FILE_PATTERN = /^(license|copying|notice|attribution)/i

export type GitHubSkillSyncOptions = {
    manifestPath: string
    skillsRoot: string
    cacheRoot: string
    fallbackCacheRoot?: string
    logger: GitHubSkillSyncLogger
    forceRefresh?: boolean
}

export type GitHubSkillSyncLogger = {
    warn(message: string): void
}

export type GitHubSkillGit = {
    isRepository(path: string): Promise<boolean>
    clone(url: string, destination: string): Promise<void>
    fetch(path: string): Promise<void>
    fetchRemote?(path: string): Promise<void>
    remoteDefaultBranch?(path: string): Promise<string>
    checkout?(path: string, revision: string): Promise<void>
    hardReset?(path: string, revision: string): Promise<void>
    clean?(path: string): Promise<void>
    revision(path: string): Promise<string>
}

export type GitHubSkillSyncFileSystem = {
    readFile(path: string, encoding?: "utf8"): Promise<string | Buffer>
    writeFile(path: string, content: string | Buffer): Promise<void>
    mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
    mkdtemp(prefix: string): Promise<string>
    readdir(path: string): Promise<string[]>
    stat(path: string): Promise<Awaited<ReturnType<typeof stat>>>
    realpath(path: string): Promise<string>
    cp(source: string, destination: string, options: { recursive: true; dereference: false }): Promise<void>
    rename(oldPath: string, newPath: string): Promise<void>
    rm(path: string, options: { recursive: true; force: true }): Promise<void>
}

export type GitHubSkillSyncDependencies = {
    git?: GitHubSkillGit
    fs?: GitHubSkillSyncFileSystem
}

export type GitHubSkillSyncResult = {
    inventory: GitHubSkillInventory
}

type SourceSelection = {
    sourceUrl: string
    category: GitHubSkillCategory
    parsed: Exclude<ParsedGitHubSkillUrl, { strategy: "invalid" }>
}

type NodeErrorWithCode = Error & {
    code?: unknown
}

class CacheFilesystemPermissionError extends Error {
    readonly cause: unknown

    constructor(cause: unknown) {
        super("GitHub skill sync: primary cache filesystem access denied")
        this.name = "CacheFilesystemPermissionError"
        this.cause = cause
    }
}

const defaultFileSystem: GitHubSkillSyncFileSystem = { readFile, writeFile, mkdir, mkdtemp, readdir, stat, realpath, cp, rename, rm }

const defaultGit: GitHubSkillGit = {
    async isRepository(path: string): Promise<boolean> {
        try {
            const result = await executeFile("git", ["-C", path, "rev-parse", "--is-inside-work-tree"])
            return result.stdout.trim() === "true"
        } catch {
            return false
        }
    },
    async clone(url: string, destination: string): Promise<void> {
        await executeFile("git", ["clone", "--", url, destination])
    },
    async fetch(path: string): Promise<void> {
        await executeFile("git", ["-C", path, "fetch", "--force", "--prune", "origin"])
        await executeFile("git", ["-C", path, "remote", "set-head", "origin", "-a"])
        await executeFile("git", ["-C", path, "reset", "--hard", "origin/HEAD"])
    },
    async fetchRemote(path: string): Promise<void> {
        await executeFile("git", ["-C", path, "fetch", "--force", "--prune", "origin"])
    },
    async remoteDefaultBranch(path: string): Promise<string> {
        await executeFile("git", ["-C", path, "remote", "set-head", "origin", "-a"])
        const result = await executeFile("git", ["-C", path, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
        const reference = result.stdout.trim()
        if (!reference.startsWith("origin/") || reference.length === "origin/".length) {
            throw syncError(`repository ${path} has invalid origin default branch`)
        }
        return reference.slice("origin/".length)
    },
    async checkout(path: string, revision: string): Promise<void> {
        await executeFile("git", ["-C", path, "checkout", "--force", "--detach", revision])
    },
    async hardReset(path: string, revision: string): Promise<void> {
        await executeFile("git", ["-C", path, "reset", "--hard", revision])
    },
    async clean(path: string): Promise<void> {
        await executeFile("git", ["-C", path, "clean", "-fdx"])
    },
    async revision(path: string): Promise<string> {
        const result = await executeFile("git", ["-C", path, "rev-parse", "HEAD"])
        return result.stdout.trim()
    },
}

function syncError(message: string): Error {
    return new Error(`GitHub skill sync: ${message}`)
}

function isSafeRelativePath(path: string): boolean {
    const segments = path.split("/")
    return !isAbsolute(path) && !path.includes("\\") && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

function isInside(root: string, path: string): boolean {
    const pathRelative = relative(resolve(root), resolve(path))
    return (pathRelative === "" || !pathRelative.startsWith("..")) && !isAbsolute(pathRelative)
}

export function isFilesystemPermissionError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const code = (error as NodeErrorWithCode).code
    return code === "EACCES" || code === "EPERM"
}

async function withPrimaryCacheAccess<T>(paths: string[], cacheRoot: string, operation: () => Promise<T>): Promise<T> {
    try {
        return await operation()
    } catch (error) {
        if (paths.some((path) => isInside(cacheRoot, path)) && isFilesystemPermissionError(error)) {
            throw new CacheFilesystemPermissionError(error)
        }
        throw error
    }
}

function primaryCacheFileSystem(fs: GitHubSkillSyncFileSystem, cacheRoot: string): GitHubSkillSyncFileSystem {
    return {
        readFile: async (path: string, encoding?: "utf8"): Promise<string | Buffer> => withPrimaryCacheAccess([path], cacheRoot, () => fs.readFile(path, encoding)),
        writeFile: async (path: string, content: string | Buffer): Promise<void> => withPrimaryCacheAccess([path], cacheRoot, () => fs.writeFile(path, content)),
        mkdir: async (path: string, options?: { recursive?: boolean }): Promise<string | undefined> => withPrimaryCacheAccess([path], cacheRoot, () => fs.mkdir(path, options)),
        mkdtemp: async (prefix: string): Promise<string> => withPrimaryCacheAccess([prefix], cacheRoot, () => fs.mkdtemp(prefix)),
        readdir: async (path: string): Promise<string[]> => withPrimaryCacheAccess([path], cacheRoot, () => fs.readdir(path)),
        stat: async (path: string): Promise<Awaited<ReturnType<typeof stat>>> => withPrimaryCacheAccess([path], cacheRoot, () => fs.stat(path)),
        realpath: async (path: string): Promise<string> => withPrimaryCacheAccess([path], cacheRoot, () => fs.realpath(path)),
        cp: async (source: string, destination: string, options: { recursive: true; dereference: false }): Promise<void> => withPrimaryCacheAccess([source, destination], cacheRoot, () => fs.cp(source, destination, options)),
        rename: async (oldPath: string, newPath: string): Promise<void> => withPrimaryCacheAccess([oldPath, newPath], cacheRoot, () => fs.rename(oldPath, newPath)),
        rm: async (path: string, options: { recursive: true; force: true }): Promise<void> => withPrimaryCacheAccess([path], cacheRoot, () => fs.rm(path, options)),
    }
}

function stagedRepositoryPath(stagingRoot: string, owner: string, project: string, repositoryPath: string): string {
    if (![owner, project, repositoryPath].every(isSafeRelativePath)) {
        throw syncError(`unsafe staged repository path ${owner}/${project}/${repositoryPath}`)
    }
    return join(stagingRoot, owner, project, repositoryPath)
}

function digest(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex")
}

function parseSelections(raw: string, manifestPath: string): SourceSelection[] {
    const errors: ParseError[] = []
    const value = parseJsonc(raw, errors, { allowTrailingComma: true, disallowComments: false })
    if (errors.length > 0) {
        throw syncError(`manifest ${manifestPath} is malformed JSONC at offset ${errors[0]?.offset ?? 0}`)
    }
    const inventory = validateGitHubSkillInventory(value, manifestPath)
    const selections = new Map<string, SourceSelection>()
    for (const entry of inventory.skills) {
        const parsed = parseGitHubSkillUrl(entry.sourceUrl)
        if (parsed.strategy === "invalid" || !isSafeRelativePath(parsed.owner) || !isSafeRelativePath(parsed.project)) {
            throw syncError(`manifest ${manifestPath} has unsafe sourceUrl "${entry.sourceUrl}"`)
        }
        if ((parsed.strategy === "blob" || parsed.strategy === "raw") && basename(entry.relativeInstallPath) !== basename(parsed.subDirs)) {
            throw syncError(`manifest ${manifestPath} sourceUrl and relativeInstallPath skill names do not match`)
        }
        const existing = selections.get(entry.sourceUrl)
        if (existing !== undefined && existing.category !== entry.category) {
            throw syncError(`sourceUrl "${entry.sourceUrl}" has conflicting categories`)
        }
        selections.set(entry.sourceUrl, { sourceUrl: entry.sourceUrl, category: entry.category, parsed })
    }
    return [...selections.values()].sort((left, right) => left.sourceUrl.localeCompare(right.sourceUrl))
}

async function cacheRepository(selection: SourceSelection, cacheRoot: string, forceRefresh: boolean, git: GitHubSkillGit, fs: GitHubSkillSyncFileSystem): Promise<{ path: string; commit: string }> {
    const path = join(cacheRoot, selection.parsed.owner, selection.parsed.project)
    const cloneUrl = cloneUrlFor(selection.parsed)
    if (cloneUrl === null) throw syncError(`cannot clone invalid sourceUrl "${selection.sourceUrl}"`)
    if (!(await git.isRepository(path))) {
        await fs.rm(path, { recursive: true, force: true })
        await fs.mkdir(dirname(path), { recursive: true })
        await git.clone(cloneUrl, path)
    }
    if (!(await git.isRepository(path))) throw syncError(`clone ${path} is not a Git repository`)
    if (forceRefresh) {
        const { fetchRemote, remoteDefaultBranch, checkout, hardReset, clean } = git
        if (fetchRemote === undefined || remoteDefaultBranch === undefined || checkout === undefined || hardReset === undefined || clean === undefined) {
            throw syncError("forced refresh Git operations are unavailable")
        }
        await fetchRemote(path)
        const branch = selection.parsed.strategy === "repo" ? await remoteDefaultBranch(path) : selection.parsed.branch
        const revision = `origin/${branch}`
        await checkout(path, revision)
        await hardReset(path, revision)
        await clean(path)
        if (!(await git.isRepository(path))) throw syncError(`refreshed cache ${path} is not a Git repository`)
    } else {
        await git.fetch(path)
    }
    const commit = await git.revision(path)
    if (!/^[0-9a-f]{40}$/i.test(commit)) throw syncError(`repository ${path} returned invalid HEAD revision`)
    return { path, commit: commit.toLowerCase() }
}

async function resolvedPath(path: string, root: string, fs: GitHubSkillSyncFileSystem): Promise<string> {
    const resolved = await fs.realpath(path)
    if (!isInside(root, resolved)) throw syncError(`external symlink rejected: ${path}`)
    return resolved
}

async function copySafeTree(source: string, destination: string, root: string, fs: GitHubSkillSyncFileSystem): Promise<void> {
    const sourcePath = await resolvedPath(source, root, fs)
    const sourceStat = await fs.stat(sourcePath)
    if (sourceStat.isDirectory()) {
        await fs.mkdir(destination, { recursive: true })
        for (const name of (await fs.readdir(sourcePath)).sort((left, right) => left.localeCompare(right))) {
            if (!isSafeRelativePath(name)) throw syncError(`unsafe repository entry "${name}"`)
            await copySafeTree(join(sourcePath, name), join(destination, name), root, fs)
        }
        return
    }
    if (!sourceStat.isFile()) throw syncError(`unsupported repository entry ${source}`)
    await fs.mkdir(dirname(destination), { recursive: true })
    await fs.cp(sourcePath, destination, { recursive: true, dereference: false })
}

async function findSkillRoots(root: string, fs: GitHubSkillSyncFileSystem): Promise<string[]> {
    const roots: string[] = []
    async function visit(path: string): Promise<void> {
        const actualPath = await resolvedPath(path, root, fs)
        const info = await fs.stat(actualPath)
        if (!info.isDirectory()) return
        const names = (await fs.readdir(actualPath)).sort((left, right) => left.localeCompare(right))
        if (names.includes("SKILL.md")) {
            const skillFile = join(actualPath, "SKILL.md")
            const skillInfo = await fs.stat(await resolvedPath(skillFile, root, fs))
            if (!skillInfo.isFile() || (await fs.readFile(skillFile) as Buffer).length === 0) throw syncError(`malformed SKILL.md at ${skillFile}`)
            roots.push(actualPath)
        }
        for (const name of names) await visit(join(actualPath, name))
    }
    await visit(root)
    return roots
}

async function hasRepositoryRootLicense(repository: string, fs: GitHubSkillSyncFileSystem): Promise<boolean> {
    for (const name of await fs.readdir(repository)) {
        if (!LEGAL_FILE_PATTERN.test(name)) continue
        const file = await fs.stat(await resolvedPath(join(repository, name), repository, fs))
        if (file.isFile()) return true
    }
    return false
}

function sourceRoot(selection: SourceSelection, repository: string): string {
    if (selection.parsed.strategy === "repo") return repository
    if (!isSafeRelativePath(selection.parsed.subDirs)) throw syncError(`unsafe source path in ${selection.sourceUrl}`)
    return join(repository, selection.parsed.subDirs)
}

async function legalFiles(repository: string, selectedRoot: string, fs: GitHubSkillSyncFileSystem): Promise<GitHubSkillLegalFile[]> {
    const files = new Map<string, GitHubSkillLegalFile>()
    async function collect(path: string, recursive: boolean): Promise<void> {
        for (const name of (await fs.readdir(path)).sort((left, right) => left.localeCompare(right))) {
            const candidate = join(path, name)
            const actualCandidate = await resolvedPath(candidate, repository, fs)
            const candidateStat = await fs.stat(actualCandidate)
            if (candidateStat.isDirectory() && recursive) {
                await collect(actualCandidate, true)
            } else if (candidateStat.isFile() && LEGAL_FILE_PATTERN.test(name)) {
                const relativePath = relative(repository, actualCandidate).split("\\").join("/")
                if (!isSafeRelativePath(relativePath)) throw syncError(`unsafe legal file ${actualCandidate}`)
                files.set(relativePath, { relativePath, sha256: digest(await fs.readFile(actualCandidate) as Buffer) })
            }
        }
    }
    await collect(repository, false)
    await collect(selectedRoot, true)
    return [...files.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function copyLegalFiles(repository: string, legal: GitHubSkillLegalFile[], stagingRoot: string, owner: string, project: string, fs: GitHubSkillSyncFileSystem): Promise<void> {
    for (const legalFile of legal) {
        await copySafeTree(join(repository, legalFile.relativePath), stagedRepositoryPath(stagingRoot, owner, project, legalFile.relativePath), repository, fs)
    }
}

async function buildInventory(selections: SourceSelection[], stagingRoot: string, cacheRoot: string, forceRefresh: boolean, logger: GitHubSkillSyncLogger, git: GitHubSkillGit, fs: GitHubSkillSyncFileSystem): Promise<GitHubSkillInventory> {
    const entries: GitHubSkillInventoryEntry[] = []
    const skillNames = new Set<string>()
    const destinations = new Set<string>()
    const warnedRepositories = new Set<string>()
    for (const selection of selections) {
        const repository = await cacheRepository(selection, cacheRoot, forceRefresh, git, fs)
        const selectedRoot = sourceRoot(selection, repository.path)
        const roots = selection.parsed.strategy === "repo" || selection.parsed.strategy === "subtree" ? await findSkillRoots(selectedRoot, fs) : [selectedRoot]
        if (roots.length === 0) throw syncError(`no SKILL.md found for ${selection.sourceUrl}`)
        if (selection.parsed.strategy === "blob" || selection.parsed.strategy === "raw") {
            if (basename(selectedRoot) === "SKILL.md") throw syncError(`invalid selected skill root for ${selection.sourceUrl}`)
        }
        if (!(await hasRepositoryRootLicense(repository.path, fs))) {
            const repositoryKey = `${selection.parsed.owner}/${selection.parsed.project}`
            if (!warnedRepositories.has(repositoryKey)) {
                logger.warn(`GitHub skill sync: ${repositoryKey} has no repository-root license`)
                warnedRepositories.add(repositoryKey)
            }
        }
        for (const root of roots.sort((left, right) => left.localeCompare(right))) {
            const skillFile = join(root, "SKILL.md")
            const skillInfo = await fs.stat(await resolvedPath(skillFile, repository.path, fs))
            if (!skillInfo.isFile() || (await fs.readFile(skillFile) as Buffer).length === 0) throw syncError(`missing or malformed SKILL.md at ${skillFile}`)
            const skillName = basename(root)
            if (!isSafeRelativePath(skillName) || skillNames.has(skillName)) throw syncError(`duplicate or unsafe skill name "${skillName}"`)
            skillNames.add(skillName)
            const relativeInstallPath = `github/${selection.parsed.owner}/${selection.parsed.project}/${skillName}`
            if (destinations.has(relativeInstallPath)) throw syncError(`duplicate install destination "${relativeInstallPath}"`)
            destinations.add(relativeInstallPath)
            const legal = await legalFiles(repository.path, root, fs)
            await copySafeTree(root, stagedRepositoryPath(stagingRoot, selection.parsed.owner, selection.parsed.project, skillName), repository.path, fs)
            await copyLegalFiles(repository.path, legal, stagingRoot, selection.parsed.owner, selection.parsed.project, fs)
            entries.push({ sourceUrl: selection.sourceUrl, resolvedCommit: repository.commit, relativeInstallPath, category: selection.category, sha256: digest(await fs.readFile(skillFile) as Buffer), legalFiles: legal })
        }
    }
    return { skills: entries.sort((left, right) => left.relativeInstallPath.localeCompare(right.relativeInstallPath)) }
}

async function validateStagedInventory(inventory: GitHubSkillInventory, stagingRoot: string, manifestPath: string, fs: GitHubSkillSyncFileSystem): Promise<void> {
    validateGitHubSkillInventory(inventory, manifestPath)
    for (const entry of inventory.skills) {
        const [, owner, project, skillName] = entry.relativeInstallPath.split("/")
        const skill = await fs.readFile(stagedRepositoryPath(stagingRoot, owner!, project!, `${skillName!}/SKILL.md`)) as Buffer
        if (digest(skill) !== entry.sha256) throw syncError(`staged snapshot digest mismatch for ${entry.relativeInstallPath}`)
        for (const legal of entry.legalFiles ?? []) {
            const legalContent = await fs.readFile(stagedRepositoryPath(stagingRoot, owner!, project!, legal.relativePath)) as Buffer
            if (digest(legalContent) !== legal.sha256) throw syncError(`staged legal digest mismatch for ${legal.relativePath}`)
        }
    }
}

async function replaceOutputs(stagingRoot: string, stagedManifest: string, options: GitHubSkillSyncOptions, fs: GitHubSkillSyncFileSystem): Promise<void> {
    const skillsBackup = `${options.skillsRoot}.backup-${randomUUID()}`
    const manifestBackup = `${options.manifestPath}.backup-${randomUUID()}`
    let skillsMoved = false
    let manifestMoved = false
    try {
        await fs.rename(options.skillsRoot, skillsBackup)
        skillsMoved = true
        await fs.rename(stagingRoot, options.skillsRoot)
        await fs.rename(options.manifestPath, manifestBackup)
        manifestMoved = true
        await fs.rename(stagedManifest, options.manifestPath)
        await fs.rm(skillsBackup, { recursive: true, force: true })
        await fs.rm(manifestBackup, { recursive: true, force: true })
    } catch (error) {
        if (manifestMoved) {
            await fs.rm(options.manifestPath, { recursive: true, force: true })
            await fs.rename(manifestBackup, options.manifestPath)
        }
        if (skillsMoved) {
            await fs.rm(options.skillsRoot, { recursive: true, force: true })
            await fs.rename(skillsBackup, options.skillsRoot)
        }
        throw error
    }
}

async function syncGitHubSkillInventoryAtCache(options: GitHubSkillSyncOptions, selections: SourceSelection[], cacheRoot: string, git: GitHubSkillGit, fs: GitHubSkillSyncFileSystem): Promise<GitHubSkillSyncResult> {
    const stagingRoot = await fs.mkdtemp(join(dirname(options.skillsRoot), ".github-skills-"))
    const stagedManifest = `${options.manifestPath}.staging-${randomUUID()}`
    try {
        const inventory = await buildInventory(selections, stagingRoot, cacheRoot, options.forceRefresh === true, options.logger, git, fs)
        await validateStagedInventory(inventory, stagingRoot, options.manifestPath, fs)
        await fs.writeFile(stagedManifest, `${JSON.stringify(inventory, null, 4)}\n`)
        await replaceOutputs(stagingRoot, stagedManifest, options, fs)
        return { inventory }
    } catch (error) {
        await fs.rm(stagingRoot, { recursive: true, force: true })
        await fs.rm(stagedManifest, { recursive: true, force: true })
        throw error
    }
}

export async function syncGitHubSkillInventory(options: GitHubSkillSyncOptions, dependencies: GitHubSkillSyncDependencies = {}): Promise<GitHubSkillSyncResult> {
    const fs = dependencies.fs ?? defaultFileSystem
    const git = dependencies.git ?? defaultGit
    const rawManifest = await fs.readFile(options.manifestPath, "utf8") as string
    const selections = parseSelections(rawManifest, options.manifestPath)
    try {
        return await syncGitHubSkillInventoryAtCache(options, selections, options.cacheRoot, git, primaryCacheFileSystem(fs, options.cacheRoot))
    } catch (error) {
        if (!(error instanceof CacheFilesystemPermissionError)) throw error
        if (options.fallbackCacheRoot === undefined) throw error.cause
        return syncGitHubSkillInventoryAtCache(options, selections, options.fallbackCacheRoot, git, fs)
    }
}
