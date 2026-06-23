import { tool } from "@opencode-ai/plugin"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { isMissingFile, resolveAgentsStorageRoot } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

const learnedSkillBaseSubjects = ["corrections", "env", "permissions", "preferences"] as const
export const learnedSkillSubjects = ["learned_corrections", "learned_env", "learned_permissions", "learned_preferences"] as const

export type LearnedSkillSubject = typeof learnedSkillBaseSubjects[number]

type FileSystem = {
    mkdir: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    writeFile: (filePath: string, content: string) => Promise<void>
}

type SkillLearnArgs = {
    title?: unknown
    content?: unknown
}

type ValidatedSkillLearnArgs = {
    title: string
    content: string
}

type SkillLearnContext = {
    agent?: unknown
    directory: string
    worktree: string
}

const maxLearnedSkillLines = 100
const safePathIdentifierPattern = /^[A-Za-z0-9_-]+$/
const primaryLearnedCorrectionAgentName = "primary"
// Keep in sync with primary-mode agents in src/agents/index.ts without importing agent config here.
const primaryAgentNames = new Set(["assist", "auto", "design", "research"])

const defaultFileSystem: FileSystem = {
    mkdir,
    readFile,
    writeFile,
}

export function isSafePathIdentifier(value: string): boolean {
    return safePathIdentifierPattern.test(value)
}

function hasControlCharacter(value: string): boolean {
    return /[\u0000-\u001f\u007f]/.test(value)
}

function buildSkillReference(subject: LearnedSkillSubject, agentName?: string): string {
    const skillDirectory = learnedSkillDirectory(subject)
    return agentName === undefined ? skillDirectory : `${skillDirectory}/${agentName}`
}

function learnedSkillDirectory(subject: LearnedSkillSubject): string {
    return `learned_${subject}`
}

function buildFrontmatter(subject: LearnedSkillSubject, agentName?: string): string {
    return [
        "---",
        `description: Use ${buildSkillReference(subject, agentName)} skill to recall ${subject} of previous sessions.`,
        "---",
    ].join("\n")
}

function countMarkdownLines(content: string): number {
    if (!content) {
        return 0
    }

    const normalized = content.endsWith("\n") ? content.slice(0, -1) : content
    return normalized ? normalized.split(/\r?\n/).length : 0
}

function findFrontmatterEnd(lines: string[]): number {
    if (lines[0] !== "---") {
        return -1
    }

    const end = lines.findIndex((line, index) => index > 0 && line === "---")
    return end >= 0 ? end : -1
}

function getSectionStartIndexes(lines: string[], frontmatterEnd: number): number[] {
    return lines.reduce<number[]>((indexes, line, index) => {
        if (index > frontmatterEnd && line.startsWith("## ")) {
            indexes.push(index)
        }

        return indexes
    }, [])
}

function ensureFrontmatter(content: string, subject: LearnedSkillSubject, agentName?: string): string {
    const frontmatter = buildFrontmatter(subject, agentName)
    if (!content.trim()) {
        return frontmatter
    }

    const lines = content.split(/\r?\n/)
    if (findFrontmatterEnd(lines) >= 0) {
        return content.trimEnd()
    }

    return `${frontmatter}\n\n${content.trimEnd()}`
}

function appendLearnedSection(content: string, title: string, learnedContent: string): string {
    return `${content.trimEnd()}\n\n## ${title}\n\n${learnedContent}\n\n----------\n`
}

export function pruneEldestLearnedSection(content: string, maxLines: number = maxLearnedSkillLines): { content: string, pruned: boolean, lineCount: number } {
    const lineCount = countMarkdownLines(content)
    if (lineCount <= maxLines) {
        return { content, pruned: false, lineCount }
    }

    const lines = content.split(/\r?\n/)
    const frontmatterEnd = findFrontmatterEnd(lines)
    const sectionStartIndexes = getSectionStartIndexes(lines, frontmatterEnd)
    const firstSectionStart = sectionStartIndexes[0]
    if (firstSectionStart === undefined) {
        return { content, pruned: false, lineCount }
    }

    const secondSectionStart = sectionStartIndexes[1] ?? lines.length
    const nextLines = [
        ...lines.slice(0, firstSectionStart),
        ...lines.slice(secondSectionStart),
    ]
    const nextContent = `${nextLines.join("\n").trimEnd()}\n`

    return { content: nextContent, pruned: true, lineCount: countMarkdownLines(nextContent) }
}

export function validateSkillLearnArgs(args: SkillLearnArgs): ValidatedSkillLearnArgs | { error: string, instruction: string } {
    const unexpectedArgs = Object.keys(args).filter((key) => !["title", "content"].includes(key))
    if (unexpectedArgs.length > 0) {
        return {
            error: `Unexpected argument(s): ${unexpectedArgs.join(", ")}.`,
            instruction: "Retry with exactly title and content arguments.",
        }
    }

    if (typeof args.title !== "string" || !args.title.trim() || hasControlCharacter(args.title)) {
        return {
            error: "Invalid title. Title must be non-empty and contain no newline or control characters.",
            instruction: "Retry with a short markdown heading title on one line.",
        }
    }

    if (typeof args.content !== "string" || !args.content.trim()) {
        return {
            error: "Invalid content. Content must be non-empty.",
            instruction: "Retry with learned markdown content written in Caveman English.",
        }
    }

    return {
        title: args.title.trim(),
        content: args.content.trim(),
    }
}

function validateAgentName(agent: unknown): string | { error: string, instruction: string } {
    if (typeof agent !== "string" || !agent.trim()) {
        return {
            error: "Missing current agent name.",
            instruction: "Retry only when tool context has a current agent name.",
        }
    }

    const agentName = agent.trim()
    if (!isSafePathIdentifier(agentName)) {
        return {
            error: `Unsafe current agent name: ${agentName}`,
            instruction: "Retry only with a current agent name using letters, numbers, underscores, or hyphens.",
        }
    }

    return agentName
}

function resolveLearnedSkillAgentName(subject: LearnedSkillSubject, shared: boolean, agent: unknown): string | undefined | { error: string, instruction: string } {
    if (shared) {
        return undefined
    }

    const validatedAgentName = validateAgentName(agent)
    if (typeof validatedAgentName !== "string") {
        return validatedAgentName
    }

    if (subject === "corrections" && primaryAgentNames.has(validatedAgentName)) {
        return primaryLearnedCorrectionAgentName
    }

    return validatedAgentName
}

function resolveSkillFilePath(context: SkillLearnContext, subject: LearnedSkillSubject, agentName?: string): { filePath: string, skillsRoot: string } {
    const agentsRoot = path.join(resolveAgentsStorageRoot(context), ".agents")
    const skillsRoot = path.resolve(agentsRoot, "skills")
    const skillDirectory = learnedSkillDirectory(subject)
    const skillPathParts = agentName === undefined ? [skillDirectory, "SKILL.md"] : [skillDirectory, agentName, "SKILL.md"]
    const filePath = path.resolve(skillsRoot, ...skillPathParts)
    const relativePath = path.relative(skillsRoot, filePath)

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error(`Invalid learned skill path for ${buildSkillReference(subject, agentName)}`)
    }

    return { filePath, skillsRoot }
}

async function readExistingSkill(fileSystem: FileSystem, filePath: string): Promise<string> {
    try {
        return await fileSystem.readFile(filePath, "utf8")
    }
    catch (error) {
        if (isMissingFile(error)) {
            return ""
        }

        throw error
    }
}

const skillLearnDescriptions = {
    corrections: "call when mistake was corrected: `subject` = correction, `content` = summarize mistake + correction steps or lessons learned",
    env: "call when limitation found in local dev environment: `subject` = environment, `content` = non-obvious details about developer environment like os/platform/hardware limitations, nonstandard scripts/aliases/cli commands in os, dev network details, access restrictions, etc.",
    permissions: "call when user says manual task was safe or warn about unsafe task: `subject` = permissions, `content` = which actions are safe and which are dangerous, including safe passwords",
    preferences: "call when ASSIGNMENT/job is complete but reviewer complaint about implementation/report: `subject` = preferences, `content` = reviewer preferences like programming patterns, file organization, naming conventions, etc.",
} satisfies Record<LearnedSkillSubject, string>

function createSkillLearnTool(toolName: string, subject: LearnedSkillSubject, fileSystem: FileSystem = defaultFileSystem, shared = false): ReturnType<typeof tool> {
    return tool({
        description: `Call \`${toolName}\` to learn new skills when:
${skillLearnDescriptions[subject]}
`,
        args: {
            title: tool.schema.string().describe("Short markdown heading for content."),
            content: tool.schema.string().describe("Summary of what was learned in Caveman English."),
        },
        async execute(args, context) {
            const validatedArgs = validateSkillLearnArgs(args)
            if ("error" in validatedArgs) {
                return createRetryResponse("learn skill", validatedArgs.error, validatedArgs.instruction)
            }

            const agentName = resolveLearnedSkillAgentName(subject, shared, (context as SkillLearnContext).agent)
            if (agentName !== undefined && typeof agentName !== "string") {
                return createRetryResponse("learn skill", agentName.error, agentName.instruction)
            }

            try {
                const { filePath } = resolveSkillFilePath(context, subject, agentName)
                await fileSystem.mkdir(path.dirname(filePath), { recursive: true })
                const existingContent = await readExistingSkill(fileSystem, filePath)
                const nextContent = appendLearnedSection(
                    ensureFrontmatter(existingContent, subject, agentName),
                    validatedArgs.title,
                    validatedArgs.content
                )
                const pruned = pruneEldestLearnedSection(nextContent)
                await fileSystem.writeFile(filePath, pruned.content)

                return "OK"
            }
            catch (error) {
                return createAbortResponse("learn skill", error)
            }
        },
    })
}

export function createSkillLearnCorrectionTool(fileSystem: FileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return createSkillLearnTool("skill_learn_correction", "corrections", fileSystem)
}

export function createSkillLearnEnvTool(fileSystem: FileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return createSkillLearnTool("skill_learn_env", "env", fileSystem, true)
}

export function createSkillLearnPermissionTool(fileSystem: FileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return createSkillLearnTool("skill_learn_permission", "permissions", fileSystem, true)
}

export function createSkillLearnPreferenceTool(fileSystem: FileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return createSkillLearnTool("skill_learn_preference", "preferences", fileSystem, true)
}
