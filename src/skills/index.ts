import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveOpenCodePaths, type OpenCodePathResolverDependencies } from "@/utils/paths"

export type ManagedSkillDefinition = {
    name: string
    description: string
    directory: string
    content: string
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

export function getBundledSkillsRoot(): string {
    return skillSourceRoot
}

export function getGeneratedSkillsRoot(dependencies: OpenCodePathResolverDependencies = {}): string {
    return resolveOpenCodePaths(dependencies).generatedSkillsRoot
}
