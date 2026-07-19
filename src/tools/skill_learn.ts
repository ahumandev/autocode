import { tool } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "fs"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { resolveAgentsStorageRoot } from "@/utils/jobs"
import { upsertReferencesSection } from "@/tools/skill_shared"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

const triggerDescriptionArg = "Trigger description of: situations, symptoms, task that should make agent recall this skill. Use `skill-write` skill to see correct format."

const learnedSkillBaseSubjects = ["correction", "env", "permission", "preference"] as const

export type LearnedSkillSubject = typeof learnedSkillBaseSubjects[number]

const subjectDirName: Record<LearnedSkillSubject, string> = {
    correction: "corrections",
    env: "env",
    permission: "permissions",
    preference: "preferences",
}

type FileSystem = {
    mkdir: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>
    writeFile: (filePath: string, content: string) => Promise<void>
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    rm: (filePath: string, options?: { force?: boolean }) => Promise<void>
}

type SkillLearnReferenceArg = {
    description: string
    path: string
    content: string
}

type SkillLearnArgs = {
    category?: unknown
    name?: unknown
    content?: unknown
    description?: unknown
    key?: unknown
    references?: unknown
}

type ValidatedSkillLearnArgs = {
    category: LearnedSkillSubject
    name: string
    content: string
    description: string
    key?: string
    references?: SkillLearnReferenceArg[]
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
    readFile,
    rm,
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

function sanitizeLearnedKey(key: string): string {
    const lowered = key.toLowerCase().trim()
    const stripped = lowered.replace(/[^a-z0-9-]/g, "-")
    return stripped.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "")
}

function stripRedundantLearnedPrefix(topic: string, subject: LearnedSkillSubject): string {
    let stripped = topic
    if (stripped.startsWith("learned-")) {
        stripped = stripped.slice("learned-".length)
    }
    const subjectPrefix = `${subject}-`
    if (stripped.startsWith(subjectPrefix)) {
        stripped = stripped.slice(subjectPrefix.length)
    }
    return stripped || topic
}

function buildLearnedSkillName(subject: LearnedSkillSubject, topic: string, key?: string): string {
    const sanitizedKey = key !== undefined && key !== "" ? sanitizeLearnedKey(key) : ""
    const keySegment = sanitizedKey !== "" ? `-${sanitizedKey}` : ""
    const dedupedTopic = stripRedundantLearnedPrefix(topic, subject)
    return `learned-${subject}${keySegment}-${dedupedTopic}`
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
    key?: string,
): { skillDir: string, skillFilePath: string, skillDirName: string } {
    const agentsRoot = path.join(resolveAgentsStorageRoot(context), ".agents")
    const skillsRoot = path.resolve(agentsRoot, "skills")
    const topic = sanitizeLearnedName(name)
    const skillDirName = buildLearnedSkillName(subject, topic, key)
    const skillDir = path.resolve(skillsRoot, `learned-${subjectDirName[subject]}`, skillDirName)
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
    key?: string,
    references?: SkillLearnReferenceArg[],
): Promise<string> {
    const { skillDir, skillFilePath, skillDirName } = computeLearnedSkillPaths(context, subject, name, key)

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

    let previousSkillMd = ""
    try {
        previousSkillMd = await fileSystem.readFile(skillFilePath, "utf8")
    } catch {
        previousSkillMd = ""
    }

    await fileSystem.writeFile(skillFilePath, fileContent)

    if (references && references.length > 0) {
        const changes: Array<{ path: string, description?: string, deleted: boolean }> = []
        for (const reference of references) {
            const referencePath = reference.path.trim()
            const targetFilePath = path.join(skillDir, referencePath)
            if (reference.content === "[delete]") {
                await fileSystem.rm(targetFilePath, { force: true })
                changes.push({ path: referencePath, deleted: true })
            } else {
                await fileSystem.mkdir(path.dirname(targetFilePath), { recursive: true })
                await fileSystem.writeFile(targetFilePath, reference.content)
                changes.push({ path: referencePath, description: reference.description.trim(), deleted: false })
            }
        }

        const updatedSkillMd = upsertReferencesSection(previousSkillMd || fileContent, changes)
        await fileSystem.writeFile(skillFilePath, updatedSkillMd)
    }

    return skillFilePath
}

type ValidateSkillLearnOptions = {
    context?: SkillLearnContext
}

type DescriptionResolution = { ok: true, value: string } | { ok: false, error: string, instruction: string }

function resolveDescription(
    args: SkillLearnArgs,
    options: ValidateSkillLearnOptions | undefined,
    subject: LearnedSkillSubject,
    trimmedName: string,
    key: string | undefined,
): DescriptionResolution {
    const rawDescription = typeof args.description === "string" ? args.description : ""
    const trimmedDescription = rawDescription.trim()

    if (!trimmedDescription) {
        if (!options?.context) {
            return {
                ok: false,
                error: "Invalid description. Description must be non-empty and contain no newline or control characters.",
                instruction: "Retry with a trigger description on one line that describes when to use this skill.",
            }
        }
        const { skillFilePath } = computeLearnedSkillPaths(options.context, subject, trimmedName, key)
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
    options?: ValidateSkillLearnOptions,
): ValidatedSkillLearnArgs | { error: string, instruction: string } {
    if (typeof args.category !== "string" || !learnedSkillBaseSubjects.includes(args.category as LearnedSkillSubject)) {
        return {
            error: `Invalid category: "${String(args.category)}". Must be one of: correction, env, permission, preference.`,
            instruction: "Retry with a valid category argument.",
        }
    }
    const category = args.category as LearnedSkillSubject

    const allowedArgs = ["category", "name", "content", "description", "key", "references"]
    const unexpectedArgs = Object.keys(args).filter((argKey) => !allowedArgs.includes(argKey))
    if (unexpectedArgs.length > 0) {
        return {
            error: `Unexpected argument(s): ${unexpectedArgs.join(", ")}.`,
            instruction: "Retry with category, name, content, description, key, and references arguments.",
        }
    }

    if (args.key !== undefined && typeof args.key !== "string") {
        return {
            error: "Invalid key. Key must be a string when provided.",
            instruction: "Retry with key omitted, blank, or using letters, numbers, underscores, or hyphens.",
        }
    }

    const key = typeof args.key === "string" && args.key.trim() ? args.key.trim().toLowerCase() : undefined
    if (key !== undefined && !isSafePathIdentifier(key)) {
        return {
            error: `Unsafe key: ${args.key}`,
            instruction: "Retry with key using letters, numbers, underscores, or hyphens.",
        }
    }

    if (typeof args.name !== "string" || !args.name.trim() || hasControlCharacter(args.name)) {
        return {
            error: "Invalid name. Name must be non-empty and contain no newline or control characters.",
            instruction: "Retry with a short non-empty name on one line.",
        }
    }

    const trimmedName = args.name.trim()
    const descriptionResult = resolveDescription(args, options, category, trimmedName, key)
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
        category,
        name: trimmedName,
        content: args.content.trim(),
        description: descriptionResult.value,
        key,
        references: args.references as SkillLearnReferenceArg[] | undefined,
    }
}

export function createSkillLearnTool(fileSystem: FileSystem = defaultFileSystem): ReturnType<typeof tool> {
    const args = {
        category: tool.schema.string().describe("Category identified."),
        name: tool.schema.string().describe("Short name used to derive skill file slug."),
        content: tool.schema.string().describe("Summary of what was learned in Caveman English. Do NOT wrap content in XML tags."),
        description: tool.schema.string().optional().describe(triggerDescriptionArg),
        key: tool.schema.string().optional().describe("Optional identifier to namespace this skill, e.g. ssh_key to specify which remote host env info relates."),
        references: tool.schema.array(tool.schema.object({
            description: tool.schema.string().describe("Short reference description, max 10 words"),
            path: tool.schema.string().describe("Path relative from main skill `content` (SKILL.md) to reference file."),
            content: tool.schema.string().describe("File content. Use \"[delete]\" to delete existing reference file."),
        })).optional().describe("Optional list of reference files (templates, examples, detailed info) that main skill `content` link to."),
    }

    return tool({
        description: `Call \`skill_learn\` when learn new skill when one of these categories were identified:
- "corrections": self corrected mistakes: summarize mistake + correction steps or lessons learned
- "env": unusual capability / limitation found in dev/remote environment: non-obvious details about developer environment like os/platform/hardware limitations, nonstandard scripts/aliases/cli commands in os, dev network details, access restrictions, etc.
- "permissions": user says manual task was safe / warn about unsafe task / insist task must be manual: which actions are safe and which are dangerous, including safe passwords.
- "preferences": user corrected you after wrong action (words like \"Always\", \"Never\", \"Remember\", SHOUTS with \"!!!\"): complaint / preference / permanent rule like programming patterns, file organization, naming conventions, editing style, etc.
        `,
        args,
        async execute(args, context) {
            const validatedArgs = validateSkillLearnArgs(args, {
                context: context as SkillLearnContext,
            })
            if ("error" in validatedArgs) {
                return createRetryResponse("learn skill", validatedArgs.error, validatedArgs.instruction)
            }

            try {
                await writeLearnedSkillDir(
                    fileSystem,
                    context as SkillLearnContext,
                    validatedArgs.category,
                    validatedArgs.name,
                    validatedArgs.content,
                    validatedArgs.description,
                    validatedArgs.key,
                    validatedArgs.references
                )

                return "OK"
            }
            catch (error) {
                return createAbortResponse("learn skill", error)
            }
        },
    })
}
