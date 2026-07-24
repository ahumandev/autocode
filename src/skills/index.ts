import { existsSync, readFileSync, statSync, type Dirent } from "node:fs"
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
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

function getSkillsRoot(): string {
    return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".agents"), "skills")
}

export function getGeneratedSkillsRoot(): string {
    return path.join(getSkillsRoot(), "autocode")
}

export function getGeneratedGitHubSkillsRoot(): string {
    return path.join(getSkillsRoot(), "github")
}

function assertSafeRelativePath(relativePath: string): void {
    const segments = relativePath.split("/")
    if (path.isAbsolute(relativePath) || relativePath.includes("\\") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error(`Unsafe bundled skill path: ${relativePath}`)
    }
}

function skillRootExists(destination: string): boolean {
    try {
        return statSync(destination).isDirectory()
    } catch {
        return false
    }
}

async function extractMissingSkill(source: ManagedBundleItem, destination: string): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true })
    const stagingRoot = await mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}.stage-`))
    const stagingPath = path.join(stagingRoot, path.basename(destination))
    try {
        await cp(source.sourcePath, stagingPath, { recursive: true, dereference: false })
        await rename(stagingPath, destination)
    } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true })
        throw error
    }
    await rm(stagingRoot, { recursive: true, force: true })
}

async function managedBundleItems(): Promise<{ items: ManagedBundleItem[]; externalSkills: ExternalSkill[] }> {
    const items: ManagedBundleItem[] = []
    for (const directory of managedSkillDirectories) {
        const sourcePath = path.join(skillSourceRoot, directory)
        items.push({ relativePath: directory, sourcePath })
    }

    const inventoryPath = path.join(skillSourceRoot, "github.jsonc")
    const inventory = await loadGitHubSkillInventory(inventoryPath, skillSourceRoot)
    for (const skill of inventory.skills) {
        assertSafeRelativePath(skill.relativeInstallPath)
        items.push({ relativePath: skill.relativeInstallPath, sourcePath: path.join(skillSourceRoot, skill.relativeInstallPath) })
    }

    const externalSkills = inventory.skills.map((skill) => {
        const [, owner, project, skillName] = skill.relativeInstallPath.split("/")
        if (!owner || !project || !skillName) throw new Error(`Invalid GitHub skill path: ${skill.relativeInstallPath}`)
        return { category: skill.category, skillName, owner, project }
    })
    return { items, externalSkills: dedupeExternalSkills(externalSkills) }
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
    const changedPaths: string[] = []

    for (const item of bundle.items) {
        const isGitHubSkill = item.relativePath.startsWith("github/")
        const destination = isGitHubSkill
            ? path.join(getGeneratedGitHubSkillsRoot(), item.relativePath.slice("github/".length))
            : path.join(root, item.relativePath)
        if (skillRootExists(destination)) continue
        try {
            await extractMissingSkill(item, destination)
            changedPaths.push(destination)
        } catch (error) {
            console.warn(`autocode: skill extraction failed for ${item.relativePath}: ${error instanceof Error ? error.message : String(error)}`)
        }
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
