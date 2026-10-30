import { existsSync, readFileSync, statSync } from "node:fs"
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveOpenCodePaths, type OpenCodePathResolverDependencies } from "@/utils/paths"

export type ManagedSkillDefinition = {
    name: string
    description: string
    directory: string
    content: string
}

export type GeneratedSkillsOptions = OpenCodePathResolverDependencies & {
    skipExtraction?: boolean
}

export type GeneratedSkillsResult = {
    root: string
    changedPaths: string[]
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
    "author-fallacies",
    "author-readme",
    "author-rules",
    "code-angular",
    "code-java",
    "code-rest",
    "code-typescript",
    "execute-sandbox",
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

export function getGeneratedSkillsRoot(dependencies: OpenCodePathResolverDependencies = {}): string {
    return resolveOpenCodePaths(dependencies).generatedSkillsRoot
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

function managedBundleItems(): ManagedBundleItem[] {
    return managedSkillDirectories.map((directory) => ({
        relativePath: directory,
        sourcePath: path.join(skillSourceRoot, directory),
    }))
}

export async function reconcileGeneratedSkills(options: GeneratedSkillsOptions = {}): Promise<GeneratedSkillsResult> {
    const paths = resolveOpenCodePaths(options)
    const root = paths.generatedSkillsRoot
    const items = managedBundleItems()
    if (options.skipExtraction) return { root, changedPaths: [] }

    await mkdir(root, { recursive: true })
    const changedPaths: string[] = []

    for (const item of items) {
        const destination = path.join(root, item.relativePath)
        if (skillRootExists(destination)) continue
        try {
            await extractMissingSkill(item, destination)
            changedPaths.push(destination)
        } catch (error) {
            console.warn(`autocode: skill extraction failed for ${item.relativePath}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    return { root, changedPaths }
}

export async function ensureGeneratedSkills(options: GeneratedSkillsOptions = {}): Promise<string> {
    return (await reconcileGeneratedSkills(options)).root
}
