import { tool } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "fs"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { resolveAgentsStorageRoot } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

const triggerDescriptionArg = "Trigger description of: situations, symptoms, task that should make agent recall this skill. Use `skill-write` skill to see correct format."

const learnedSkillBaseSubjects = ["corrections", "env", "permissions", "preferences"] as const

export type LearnedSkillSubject = typeof learnedSkillBaseSubjects[number]

type FileSystem = {
    mkdir: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>
    writeFile: (filePath: string, content: string) => Promise<void>
}

type SkillLearnArgs = {
    name?: unknown
    content?: unknown
    description?: unknown
    ssh_key?: unknown
}

type ValidatedSkillLearnArgs = {
    name: string
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
    writeFile,
}

export function isSafePathIdentifier(value: string): boolean {
    return safePathIdentifierPattern.test(value)
}

function hasControlCharacter(value: string): boolean {
    return /[\u0000-\u001f\u007f]/.test(value)
}

function sanitizeLearnedName(name: string): string {
    const lowered = name.toLowerCase().replace(/\s+/g, "-")
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

function buildLearnedSkillName(subject: LearnedSkillSubject, topic: string, sshKey?: string): string {
    const sanitizedSshKey = sshKey !== undefined && sshKey !== "" ? sanitizeLearnedSshKey(sshKey) : ""
    const sshSegment = subject === "env" && sanitizedSshKey !== "" ? `-${sanitizedSshKey}` : ""
    return `learned-${subject}${sshSegment}-${topic}`
}

function buildLearnedFrontmatter(skillName: string, description: string): string {
    return [
        "---",
        `name: ${skillName}`,
        `description: ${description}`,
        "---",
    ].join("\n")
}

function buildLearnedSkillBody(name: string, content: string): string {
    return [
        content,
        "",
        "---",
        "",
        `Content outdated? Call \`skill_learn\` with name=\`${name}\` to correct.`,
        "",
    ].join("\n")
}

function computeLearnedSkillPaths(
    context: SkillLearnContext,
    subject: LearnedSkillSubject,
    name: string,
    sshKey?: string,
): { skillDir: string, skillFilePath: string, skillDirName: string } {
    const agentsRoot = path.join(resolveAgentsStorageRoot(context), ".agents")
    const skillsRoot = path.resolve(agentsRoot, "skills")
    const topic = sanitizeLearnedName(name)
    const skillDirName = buildLearnedSkillName(subject, topic, sshKey)
    const skillDir = path.resolve(skillsRoot, `learned-${subject}`, skillDirName)
    return {
        skillDir,
        skillFilePath: path.join(skillDir, "SKILL.md"),
        skillDirName,
    }
}

// Returns parsed description from existing SKILL.md frontmatter, or null if file
// exists but has no description line, or undefined if file does not exist.
function readExistingSkillDescription(filePath: string): string | null | undefined {
    if (!existsSync(filePath)) return undefined
    const content = readFileSync(filePath, "utf8")
    const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n?/)
    if (!match) return null
    const frontmatter = match[0]
    const descMatch = frontmatter.match(/^description:\s*(.*)$/m)
    if (!descMatch) return null
    const value = descMatch[1].trim()
    return value || null
}

async function writeLearnedSkillDir(
    fileSystem: FileSystem,
    context: SkillLearnContext,
    subject: LearnedSkillSubject,
    name: string,
    content: string,
    description: string,
    sshKey?: string
): Promise<string> {
    const { skillDir, skillFilePath, skillDirName } = computeLearnedSkillPaths(context, subject, name, sshKey)

    const relativePath = path.relative(
        path.resolve(resolveAgentsStorageRoot(context), ".agents", "skills"),
        skillDir,
    )
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error(`Invalid learned skill path for ${skillDirName}`)
    }

    const frontmatter = buildLearnedFrontmatter(skillDirName, description)
    const body = buildLearnedSkillBody(skillDirName, content)
    const fileContent = `${frontmatter}\n\n${body}`

    await fileSystem.mkdir(skillDir, { recursive: true })
    await fileSystem.writeFile(skillFilePath, fileContent)

    return skillFilePath
}

type ValidateSkillLearnOptions = {
    subject?: LearnedSkillSubject
    context?: SkillLearnContext
}

type DescriptionResolution = { ok: true, value: string } | { ok: false, error: string, instruction: string }

function resolveDescription(
    args: SkillLearnArgs,
    options: ValidateSkillLearnOptions | undefined,
    trimmedName: string,
    sshKey: string | undefined,
): DescriptionResolution {
    const rawDescription = typeof args.description === "string" ? args.description : ""
    const trimmedDescription = rawDescription.trim()

    if (!trimmedDescription) {
        if (!options?.subject || !options?.context) {
            return {
                ok: false,
                error: "Invalid description. Description must be non-empty and contain no newline or control characters.",
                instruction: "Retry with a trigger description on one line that describes when to use this skill.",
            }
        }
        const { skillFilePath } = computeLearnedSkillPaths(options.context, options.subject, trimmedName, sshKey)
        const existing = readExistingSkillDescription(skillFilePath)
        if (existing === undefined) {
            return {
                ok: false,
                error: "description required for new skill",
                instruction: "Retry with a trigger description on one line that describes when to use this skill.",
            }
        }
        if (existing === null) {
            return {
                ok: false,
                error: "Existing skill has no description in frontmatter.",
                instruction: "Retry with a trigger description on one line that describes when to use this skill.",
            }
        }
        return { ok: true, value: existing }
    }

    if (hasControlCharacter(rawDescription)) {
        return {
            ok: false,
            error: "Invalid description. Description must be non-empty and contain no newline or control characters.",
            instruction: "Retry with a trigger description on one line that describes when to use this skill.",
        }
    }
    return { ok: true, value: trimmedDescription }
}

export function validateSkillLearnArgs(
    args: SkillLearnArgs,
    allowSshKey = false,
    options?: ValidateSkillLearnOptions,
): ValidatedSkillLearnArgs | { error: string, instruction: string } {
    const allowedArgs = allowSshKey ? ["name", "content", "description", "ssh_key"] : ["name", "content", "description"]
    const unexpectedArgs = Object.keys(args).filter((key) => !allowedArgs.includes(key))
    if (unexpectedArgs.length > 0) {
        return {
            error: `Unexpected argument(s): ${unexpectedArgs.join(", ")}.`,
            instruction: allowSshKey
                ? "Retry with name, content, description, and optional ssh_key arguments."
                : "Retry with name, content, and description arguments.",
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

    if (typeof args.name !== "string" || !args.name.trim() || hasControlCharacter(args.name)) {
        return {
            error: "Invalid name. Name must be non-empty and contain no newline or control characters.",
            instruction: "Retry with a short non-empty name on one line.",
        }
    }

    const trimmedName = args.name.trim()
    const descriptionResult = resolveDescription(args, options, trimmedName, sshKey)
    if (!descriptionResult.ok) {
        return { error: descriptionResult.error, instruction: descriptionResult.instruction }
    }

    if (typeof args.content !== "string" || !args.content.trim()) {
        return {
            error: "Invalid content. Content must be non-empty.",
            instruction: "Retry with learned markdown content written in Caveman English.",
        }
    }

    return {
        name: trimmedName,
        content: args.content.trim(),
        description: descriptionResult.value,
        sshKey,
    }
}

const skillLearnDescriptions = {
    corrections: "mistake was self corrected: `subject` = correction, `content` = summarize mistake + correction steps or lessons learned.",
    env: "unusual capability / limitation found in local dev environment: `subject` = environment, `content` = non-obvious details about developer environment like os/platform/hardware limitations, nonstandard scripts/aliases/cli commands in os, dev network details, access restrictions, etc.",
    permissions: "user says manual task was safe / warn about unsafe task / insist task must be manual: `subject` = permissions, `content` = which actions are safe and which are dangerous, including safe passwords.",
    preferences: "user set permanent (words like \"always\", \"never\", \"remember\" or CAPITAL LETTERS AND !!!) preferences: `subject` = preferences, `content` = complaint / preference / permanent rule like programming patterns, file organization, naming conventions, editing style, etc.",
} satisfies Record<LearnedSkillSubject, string>

function createSkillLearnTool(toolName: string, subject: LearnedSkillSubject, fileSystem: FileSystem = defaultFileSystem, allowSshKey = false): ReturnType<typeof tool> {
    const args = {
        name: tool.schema.string().describe("Short name used to derive the skill file slug."),
        content: tool.schema.string().describe("Summary of what was learned in Caveman English."),
        description: tool.schema.string().describe(triggerDescriptionArg),
        ...(allowSshKey ? { ssh_key: tool.schema.string().optional().describe("Only if skill relate to remote SFTP/SSH env with known ssh_key, otherwise omit.") } : {}),
    }

    return tool({
        description: `Call \`${toolName}\` to remember when ${skillLearnDescriptions[subject]} Call same name again with same name to UPDATE an outdated skill.`,
        args,
        async execute(args, context) {
            const validatedArgs = validateSkillLearnArgs(args, allowSshKey, {
                subject,
                context: context as SkillLearnContext,
            })
            if ("error" in validatedArgs) {
                return createRetryResponse("learn skill", validatedArgs.error, validatedArgs.instruction)
            }

            try {
                await writeLearnedSkillDir(
                    fileSystem,
                    context as SkillLearnContext,
                    subject,
                    validatedArgs.name,
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