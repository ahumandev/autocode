import { tool } from "@opencode-ai/plugin"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { isMissingFile, resolveAgentsStorageRoot } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

const learnedSkillBaseSubjects = ["corrections", "env", "permissions", "preferences"] as const

export type LearnedSkillSubject = typeof learnedSkillBaseSubjects[number]

type FileSystem = {
    mkdir: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    writeFile: (filePath: string, content: string) => Promise<void>
}

type SkillLearnArgs = {
    title?: unknown
    content?: unknown
    description?: unknown
    ssh_key?: unknown
}

type ValidatedSkillLearnArgs = {
    title: string
    content: string
    description: string
    sshKey?: string
}

type SkillLearnContext = {
    agent?: unknown
    directory: string
    worktree: string
}

const safePathIdentifierPattern = /^[A-Za-z0-9_-]+$/

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

function formatLearnedTimestamp(date: Date): string {
    const yy = String(date.getFullYear() % 100).padStart(2, "0")
    const mm = String(date.getMonth() + 1).padStart(2, "0")
    const dd = String(date.getDate()).padStart(2, "0")
    const hh = String(date.getHours()).padStart(2, "0")
    const mi = String(date.getMinutes()).padStart(2, "0")
    const ss = String(date.getSeconds()).padStart(2, "0")
    return `${yy}-${mm}-${dd}-${hh}-${mi}-${ss}`
}

function sanitizeLearnedTopic(title: string): string {
    const lowered = title.toLowerCase().replace(/\s+/g, "-")
    const stripped = lowered.replace(/[^a-z0-9-]/g, "")
    let collapsed = stripped.replace(/-{2,}/g, "-")
    if (collapsed.length > 40) {
        collapsed = collapsed.slice(0, 40)
    }
    collapsed = collapsed.replace(/^-+|-+$/g, "")
    return collapsed || "untitled"
}

function sanitizeLearnedSshKey(sshKey: string): string {
    const lowered = sshKey.toLowerCase().trim()
    const stripped = lowered.replace(/[^a-z0-9-]/g, "-")
    return stripped.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "")
}

function buildLearnedSkillName(subject: LearnedSkillSubject, timestamp: string, topic: string, sshKey?: string): string {
    const sanitizedSshKey = sshKey !== undefined && sshKey !== "" ? sanitizeLearnedSshKey(sshKey) : ""
    const sshSegment = subject === "env" && sanitizedSshKey !== "" ? `-${sanitizedSshKey}` : ""
    return `learned-${subject}-${timestamp}${sshSegment}-${topic}`
}

function buildLearnedFrontmatter(skillName: string, description: string): string {
    return [
        "---",
        `name: ${skillName}`,
        `description: ${description}`,
        "---",
    ].join("\n")
}

function buildLearnedSkillBody(title: string, content: string): string {
    return `## ${title}\n\n${content}\n\n----------\n`
}

async function pathExists(fileSystem: FileSystem, filePath: string): Promise<boolean> {
    try {
        await fileSystem.readFile(filePath, "utf8")
        return true
    }
    catch (error) {
        if (isMissingFile(error)) {
            return false
        }
        throw error
    }
}

async function resolveUniqueLearnedSkillDir(skillsRoot: string, subject: LearnedSkillSubject, baseName: string, fileSystem: FileSystem): Promise<string> {
    let candidate = path.resolve(skillsRoot, `learned-${subject}`, baseName)
    if (!(await pathExists(fileSystem, path.join(candidate, "SKILL.md")))) {
        return candidate
    }

    let counter = 2
    while (true) {
        candidate = path.resolve(skillsRoot, `learned-${subject}`, `${baseName}-${counter}`)
        if (!(await pathExists(fileSystem, path.join(candidate, "SKILL.md")))) {
            return candidate
        }
        counter += 1
    }
}

async function writeLearnedSkillDir(
    fileSystem: FileSystem,
    context: SkillLearnContext,
    subject: LearnedSkillSubject,
    title: string,
    content: string,
    description: string,
    sshKey?: string
): Promise<string> {
    const agentsRoot = path.join(resolveAgentsStorageRoot(context), ".agents")
    const skillsRoot = path.resolve(agentsRoot, "skills")
    const timestamp = formatLearnedTimestamp(new Date())
    const topic = sanitizeLearnedTopic(title)
    const baseName = buildLearnedSkillName(subject, timestamp, topic, sshKey)
    const skillDir = await resolveUniqueLearnedSkillDir(skillsRoot, subject, baseName, fileSystem)

    const relativePath = path.relative(skillsRoot, skillDir)
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error(`Invalid learned skill path for ${baseName}`)
    }

    const skillName = path.basename(skillDir)
    const frontmatter = buildLearnedFrontmatter(skillName, description)
    const body = buildLearnedSkillBody(title, content)
    const fileContent = `${frontmatter}\n\n${body}`

    await fileSystem.mkdir(skillDir, { recursive: true })
    await fileSystem.writeFile(path.join(skillDir, "SKILL.md"), fileContent)

    return path.join(skillDir, "SKILL.md")
}

export function validateSkillLearnArgs(args: SkillLearnArgs, allowSshKey = false): ValidatedSkillLearnArgs | { error: string, instruction: string } {
    const allowedArgs = allowSshKey ? ["title", "content", "description", "ssh_key"] : ["title", "content", "description"]
    const unexpectedArgs = Object.keys(args).filter((key) => !allowedArgs.includes(key))
    if (unexpectedArgs.length > 0) {
        return {
            error: `Unexpected argument(s): ${unexpectedArgs.join(", ")}.`,
            instruction: allowSshKey
                ? "Retry with title, content, description, and optional ssh_key arguments."
                : "Retry with title, content, and description arguments.",
        }
    }

    if (allowSshKey && args.ssh_key !== undefined && typeof args.ssh_key !== "string") {
        return {
            error: "Invalid ssh_key. SSH key must be a string when provided.",
            instruction: "Retry with ssh_key omitted, blank, or using letters, numbers, underscores, or hyphens.",
        }
    }

    const sshKey = allowSshKey && typeof args.ssh_key === "string" && args.ssh_key.trim() ? args.ssh_key.trim().toLowerCase() : undefined
    if (sshKey !== undefined && !isSafePathIdentifier(sshKey)) {
        return {
            error: `Unsafe ssh_key: ${args.ssh_key}`,
            instruction: "Retry with ssh_key using letters, numbers, underscores, or hyphens.",
        }
    }

    if (typeof args.title !== "string" || !args.title.trim() || hasControlCharacter(args.title)) {
        return {
            error: "Invalid title. Title must be non-empty and contain no newline or control characters.",
            instruction: "Retry with a short markdown heading title on one line.",
        }
    }

    if (typeof args.description !== "string" || !args.description.trim() || hasControlCharacter(args.description)) {
        return {
            error: "Invalid description. Description must be non-empty and contain no newline or control characters.",
            instruction: "Retry with a trigger description on one line that describes when to use this skill.",
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
        description: args.description.trim(),
        sshKey,
    }
}

const skillLearnDescriptions = {
    corrections: "mistake was corrected: `subject` = correction, `content` = summarize mistake + correction steps or lessons learned",
    env: "limitation found in local dev environment: `subject` = environment, `content` = non-obvious details about developer environment like os/platform/hardware limitations, nonstandard scripts/aliases/cli commands in os, dev network details, access restrictions, etc.",
    permissions: "user says manual task was safe or warn about unsafe task: `subject` = permissions, `content` = which actions are safe and which are dangerous, including safe passwords",
    preferences: "ASSIGNMENT/job is complete but reviewer complaint about implementation/report: `subject` = preferences, `content` = reviewer preferences like programming patterns, file organization, naming conventions, etc.",
} satisfies Record<LearnedSkillSubject, string>

const triggerDescriptionArg = "Write a trigger description: describe the situations, symptoms, or task types that should make an agent recall this skill. Focus on WHEN to use it, not a summary of the content."

function createSkillLearnTool(toolName: string, subject: LearnedSkillSubject, fileSystem: FileSystem = defaultFileSystem, allowSshKey = false): ReturnType<typeof tool> {
    const args = {
        title: tool.schema.string().describe("Short markdown heading for content."),
        content: tool.schema.string().describe("Summary of what was learned in Caveman English."),
        description: tool.schema.string().describe(triggerDescriptionArg),
        ...(allowSshKey ? { ssh_key: tool.schema.string().optional().describe("Omit for local env; otherwise SFTP/SSH key name for remote env.") } : {}),
    }

    return tool({
        description: `Call \`${toolName}\` to remember when ${skillLearnDescriptions[subject]}`,
        args,
        async execute(args, context) {
            const validatedArgs = validateSkillLearnArgs(args, allowSshKey)
            if ("error" in validatedArgs) {
                return createRetryResponse("learn skill", validatedArgs.error, validatedArgs.instruction)
            }

            try {
                await writeLearnedSkillDir(
                    fileSystem,
                    context as SkillLearnContext,
                    subject,
                    validatedArgs.title,
                    validatedArgs.content,
                    validatedArgs.description,
                    validatedArgs.sshKey
                )

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
    return createSkillLearnTool("skill_learn_permission", "permissions", fileSystem)
}

export function createSkillLearnPreferenceTool(fileSystem: FileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return createSkillLearnTool("skill_learn_preference", "preferences", fileSystem)
}