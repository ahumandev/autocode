import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, type Dirent } from "node:fs"
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "os"
import path from "path"
import { fileURLToPath } from "url"
import { isMissingFile } from "@/utils/jobs"
import { loadGitHubSkillInventory } from "./github"
import type { ExternalSkill } from "../utils/external"

export type ManagedSkillDefinition = {
    name: string
    description: string
    directory: string
    content: string
}

export type GeneratedSkillsOptions = {
    skipExtraction?: boolean
}

export type GeneratedSkillsResult = {
    root: string
    changedPaths: string[]
    externalSkills: ExternalSkill[]
}

type ManagedBundleItem = {
    relativePath: string
    sourcePath: string
    digest: string
    directory: boolean
}

type GeneratedSkillsState = {
    items: Record<string, { sha256: string }>
}

const managedSkillDirectories = [
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
] as const

function skillSourceFile(root: string, directory: string): string {
    return path.join(root, directory, "SKILL.md")
}

function findSkillSourceRoot(): string {
    const modulePath = fileURLToPath(import.meta.url)
    const moduleDir = path.dirname(modulePath)
    const firstDirectory = managedSkillDirectories[0]
    const candidates = [
        moduleDir,
        path.join(moduleDir, "skills"),
        path.join(moduleDir, "..", "src", "skills"),
        path.join(moduleDir, "..", "dist", "skills"),
    ]

    for (const candidate of candidates) {
        if (existsSync(skillSourceFile(candidate, firstDirectory))) {
            return candidate
        }
    }

    throw new Error(`Unable to locate bundled skill sources; missing ${skillSourceFile(candidates[0], firstDirectory)}`)
}

function parseSkillSource(filePath: string, directory: string): ManagedSkillDefinition {
    let source: string

    try {
        source = readFileSync(filePath, "utf8")
    } catch (error) {
        throw new Error(`Unable to read bundled skill source at ${filePath}: ${(error as Error).message}`)
    }

    const normalizedSource = source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n")
    const match = normalizedSource.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)

    if (!match) {
        throw new Error(`Invalid bundled skill source at ${filePath}: expected frontmatter with name and description`)
    }

    const frontmatter = match[1]
    const body = match[2]
    const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim()
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim()

    if (!name || !description) {
        throw new Error(`Invalid bundled skill source at ${filePath}: missing name or description frontmatter`)
    }

    return {
        name,
        description,
        directory,
        content: body.trim(),
    }
}

const skillSourceRoot = findSkillSourceRoot()

export const managedSkills: ManagedSkillDefinition[] = managedSkillDirectories.map((directory) => (
    parseSkillSource(skillSourceFile(skillSourceRoot, directory), directory)
))

export function getGeneratedSkillsRoot(): string {
    return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".agents"), "skills", "autocode")
}

function renderSkillMarkdown(skill: ManagedSkillDefinition): string {
    return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.content}\n`
}

function sha256(content: Buffer | string): string {
    return createHash("sha256").update(content).digest("hex")
}

function assertSafeRelativePath(relativePath: string): void {
    const segments = relativePath.split("/")
    if (path.isAbsolute(relativePath) || relativePath.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error(`Unsafe bundled skill path: ${relativePath}`)
    }
}

async function digestBundleTree(directory: string): Promise<string> {
    const entries = await readdir(directory, { withFileTypes: true })
    const digest = createHash("sha256")
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            digest.update(`directory\0${entry.name}\0${await digestBundleTree(entryPath)}\0`)
            continue
        }
        if (!entry.isFile() || entry.isSymbolicLink()) {
            throw new Error(`Unsupported bundled skill entry: ${entryPath}`)
        }
        digest.update(`file\0${entry.name}\0${sha256(await readFile(entryPath))}\0`)
    }
    return digest.digest("hex")
}

async function validateBundleDirectory(directory: string, expectedDigest: string): Promise<void> {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected bundled skill directory: ${directory}`)
    if (!existsSync(path.join(directory, "SKILL.md")) && !directory.includes(`${path.sep}github${path.sep}`)) {
        throw new Error(`Missing SKILL.md in bundled skill directory: ${directory}`)
    }
    if (await digestBundleTree(directory) !== expectedDigest) throw new Error(`Bundled skill digest changed while staging: ${directory}`)
}

async function loadGeneratedSkillsState(statePath: string): Promise<GeneratedSkillsState> {
    try {
        const value: unknown = JSON.parse(await readFile(statePath, "utf8"))
        if (typeof value !== "object" || value === null || Array.isArray(value) || !("items" in value)) return { items: {} }
        const items = (value as { items?: unknown }).items
        if (typeof items !== "object" || items === null || Array.isArray(items)) return { items: {} }
        const validItems: GeneratedSkillsState["items"] = {}
        for (const [relativePath, item] of Object.entries(items)) {
            try {
                assertSafeRelativePath(relativePath)
            } catch {
                continue
            }
            if (typeof item === "object" && item !== null && "sha256" in item && typeof item.sha256 === "string") {
                validItems[relativePath] = { sha256: item.sha256 }
            }
        }
        return { items: validItems }
    } catch {
        return { items: {} }
    }
}

async function replaceManagedItem(source: ManagedBundleItem, destination: string): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    const stagingRoot = await mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}.stage-`))
    const stagingPath = path.join(stagingRoot, path.basename(destination))
    const backupPath = path.join(path.dirname(destination), `.${path.basename(destination)}.backup-${randomUUID()}`)
    let backedUp = false
    try {
        if (source.directory) {
            await cp(source.sourcePath, stagingPath, { recursive: true, dereference: false })
            await validateBundleDirectory(stagingPath, source.digest)
        } else {
            await writeFile(stagingPath, await readFile(source.sourcePath))
            if (sha256(await readFile(stagingPath)) !== source.digest) throw new Error(`Bundled skill file changed while staging: ${source.sourcePath}`)
        }
        if (existsSync(destination)) {
            await rename(destination, backupPath)
            backedUp = true
        }
        await rename(stagingPath, destination)
        if (backedUp) await rm(backupPath, { recursive: true, force: true })
    } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true })
        if (backedUp) {
            await rm(destination, { recursive: true, force: true })
            await rename(backupPath, destination)
        }
        throw error
    }
    await rm(stagingRoot, { recursive: true, force: true })
}

async function writeGeneratedSkillsState(statePath: string, state: GeneratedSkillsState): Promise<void> {
    await mkdir(path.dirname(statePath), { recursive: true })
    const temporaryPath = `${statePath}.tmp-${randomUUID()}`
    try {
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 4)}\n`, "utf8")
        await rename(temporaryPath, statePath)
    } catch (error) {
        await rm(temporaryPath, { force: true })
        throw error
    }
}

async function isLegacyGitHubSymlink(destination: string, relativePath: string): Promise<boolean> {
    if (!relativePath.startsWith("github/")) return false
    try {
        return (await lstat(destination)).isSymbolicLink()
    } catch {
        return false
    }
}

async function managedBundleItems(): Promise<{ items: ManagedBundleItem[]; externalSkills: ExternalSkill[] }> {
    const items: ManagedBundleItem[] = []
    for (const directory of managedSkillDirectories) {
        const sourcePath = path.join(skillSourceRoot, directory)
        const digest = await digestBundleTree(sourcePath)
        await validateBundleDirectory(sourcePath, digest)
        items.push({ relativePath: directory, sourcePath, digest, directory: true })
    }

    const inventoryPath = path.join(skillSourceRoot, "github.jsonc")
    const inventory = await loadGitHubSkillInventory(inventoryPath, skillSourceRoot)
    const repositories = new Map<string, ExternalSkill[]>()
    for (const skill of inventory.skills) {
        const [, owner, project] = skill.relativeInstallPath.split("/")
        const repositoryPath = `github/${owner}/${project}`
        assertSafeRelativePath(repositoryPath)
        const external = { category: skill.category, skillName: skill.relativeInstallPath.split("/")[3]!, owner: owner!, project: project! }
        repositories.set(repositoryPath, [...(repositories.get(repositoryPath) ?? []), external])
    }
    for (const [relativePath] of [...repositories].sort(([left], [right]) => left.localeCompare(right))) {
        const sourcePath = path.join(skillSourceRoot, relativePath)
        const digest = await digestBundleTree(sourcePath)
        await validateBundleDirectory(sourcePath, digest)
        items.push({ relativePath, sourcePath, digest, directory: true })
    }

    items.push({ relativePath: "github.jsonc", sourcePath: inventoryPath, digest: sha256(await readFile(inventoryPath)), directory: false })
    return { items, externalSkills: dedupeExternalSkills([...repositories.values()].flat()) }
}

function dedupeExternalSkills(skills: ExternalSkill[]): ExternalSkill[] {
    const seen = new Set<string>()
    return skills.filter((skill) => {
        const key = `${skill.category}\0${skill.skillName}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

export async function reconcileGeneratedSkills(options: GeneratedSkillsOptions = {}): Promise<GeneratedSkillsResult> {
    const root = getGeneratedSkillsRoot()
    const bundle = await managedBundleItems()
    if (options.skipExtraction) return { root, changedPaths: [], externalSkills: bundle.externalSkills }

    await mkdir(root, { recursive: true })
    const statePath = path.join(root, "skills.jsonc")
    const state = await loadGeneratedSkillsState(statePath)
    const desired = new Map(bundle.items.map((item) => [item.relativePath, item]))
    const changedPaths: string[] = []

    for (const item of bundle.items) {
        const destination = path.join(root, item.relativePath)
        const recorded = state.items[item.relativePath]?.sha256
        if (recorded === item.digest && existsSync(destination) && !(await isLegacyGitHubSymlink(destination, item.relativePath))) continue
        try {
            await replaceManagedItem(item, destination)
            state.items[item.relativePath] = { sha256: item.digest }
            changedPaths.push(destination)
        } catch (error) {
            console.warn(`autocode: skill extraction failed for ${item.relativePath}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    for (const relativePath of Object.keys(state.items)) {
        if (desired.has(relativePath)) continue
        const destination = path.join(root, relativePath)
        try {
            await rm(destination, { recursive: true, force: true })
            delete state.items[relativePath]
            changedPaths.push(destination)
        } catch (error) {
            console.warn(`autocode: skill removal failed for ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    try {
        await writeGeneratedSkillsState(statePath, state)
    } catch (error) {
        console.warn(`autocode: skill state write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { root, changedPaths, externalSkills: bundle.externalSkills }
}

export async function ensureGeneratedSkills(options: GeneratedSkillsOptions = {}): Promise<string> {
    return (await reconcileGeneratedSkills(options)).root
}

const LEARNED_SKILL_CATEGORIES = ["corrections", "env", "permissions", "preferences"] as const
const LEARNED_DEFAULT_MAX = 10

export async function cleanupLearnedSkills(agentsRoot: string, max: number): Promise<void> {
    const effectiveMax = Number.isInteger(max) && max > 0 ? max : LEARNED_DEFAULT_MAX
    const skillsRoot = path.join(agentsRoot, ".agents", "skills")

    for (const category of LEARNED_SKILL_CATEGORIES) {
        const categoryDir = path.join(skillsRoot, `learned-${category}`)
        try {
            let entries: Dirent[]
            try {
                entries = await readdir(categoryDir, { withFileTypes: true })
            } catch (err) {
                if (isMissingFile(err)) continue // no-op: category dir does not exist; never create
                console.warn(`autocode: cleanup learned skills: failed to read ${categoryDir}: ${(err as Error).message}`)
                continue
            }

            const skillStats: Array<{ dir: string; mtimeMs: number }> = []
            for (const entry of entries) {
                if (!entry.isDirectory()) continue
                const skillFile = path.join(categoryDir, entry.name, "SKILL.md")
                try {
                    const stats = await stat(skillFile)
                    skillStats.push({ dir: entry.name, mtimeMs: stats.mtimeMs })
                } catch (err) {
                    if (!isMissingFile(err)) {
                        console.warn(`autocode: cleanup learned skills: failed to stat ${skillFile}: ${(err as Error).message}`)
                    }
                    // skip dirs without SKILL.md or with stat errors; never delete them
                    continue
                }
            }

            // Sort DESC by (mtimeMs, full dir name) — newest first, alpha-larger first on ties.
            skillStats.sort((a, b) => {
                if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs < b.mtimeMs ? 1 : -1
                return a.dir < b.dir ? 1 : -1
            })

            const stale = skillStats.slice(effectiveMax)
            if (stale.length === 0) continue
            await Promise.all(stale.map(async (entry) => {
                try {
                    await rm(path.join(categoryDir, entry.dir), { recursive: true, force: true })
                } catch (err) {
                    console.warn(`autocode: cleanup learned skills: failed to remove ${entry.dir}: ${(err as Error).message}`)
                }
            }))
        } catch (err) {
            console.warn(`autocode: cleanup learned skills: error for category ${category}: ${(err as Error).message}`)
        }
    }
}

export function injectGeneratedSkillsPath(paths: string[] | undefined, generatedPath: string): string[] {
    return [generatedPath, ...(paths ?? []).filter((skillPath) => skillPath !== generatedPath)]
}
