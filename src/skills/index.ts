import { existsSync, readFileSync, type Dirent } from "fs"
import { mkdir, readdir, rm, writeFile } from "fs/promises"
import { homedir } from "os"
import path from "path"
import { fileURLToPath } from "url"
import { isMissingFile } from "@/utils/jobs"

export type ManagedSkillDefinition = {
    name: string
    description: string
    directory: string
    content: string
}

const managedSkillDirectories = [
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
    "git-commit",
    "primary-manual",
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

export async function ensureGeneratedSkills(): Promise<string> {
    const generatedSkillsRoot = getGeneratedSkillsRoot()

    await mkdir(generatedSkillsRoot, { recursive: true })
    const staleEntries = await readdir(generatedSkillsRoot, { withFileTypes: true })
    await Promise.all(
        staleEntries.map((entry) => rm(path.join(generatedSkillsRoot, entry.name), { recursive: true, force: true })),
    )

    await Promise.all(
        managedSkills.map(async (skill) => {
            const skillDir = path.join(generatedSkillsRoot, skill.directory)
            await mkdir(skillDir, { recursive: true })
            await writeFile(path.join(skillDir, "SKILL.md"), renderSkillMarkdown(skill), "utf8")
        }),
    )

    return generatedSkillsRoot
}

const LEARNED_SKILL_CATEGORIES = ["corrections", "env", "permissions", "preferences"] as const
const LEARNED_DEFAULT_MAX = 10

function learnedTimestampRegex(category: string): RegExp {
    return new RegExp(`^learned-${category}-(\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2})`)
}

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

            const pattern = learnedTimestampRegex(category)
            const matches: Array<{ dir: string; timestamp: string }> = []
            for (const entry of entries) {
                if (!entry.isDirectory()) continue
                const match = entry.name.match(pattern)
                if (!match) continue // skills without timestamp prefix are NEVER deleted
                matches.push({ dir: entry.name, timestamp: match[1] })
            }

            // Sort DESC by (timestamp, full dir name) — newest first, alpha-larger first on ties.
            matches.sort((a, b) => {
                if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1
                return a.dir < b.dir ? 1 : -1
            })

            const stale = matches.slice(effectiveMax)
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
