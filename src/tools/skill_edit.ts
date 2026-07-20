import { tool } from "@opencode-ai/plugin"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"
import { resolveAgentsStorageRoot } from "@/utils/jobs"
import { upsertReferencesSection } from "@/tools/skill_shared"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type FileSystem = {
    mkdir: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>
    writeFile: (filePath: string, content: string) => Promise<void>
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    rm: (filePath: string, options?: { force?: boolean }) => Promise<void>
}

const defaultFileSystem: FileSystem = { mkdir, writeFile, readFile, rm }

const MAX_LINES = 500

// Maps calling agent to the only skill it may edit; overrides args.name for those agents
export const AGENT_SKILL_MAP: Record<string, string> = {
    "document_conventions": "design-conventions",
    "document_code": "execute-code",
    "document_install": "execute-install",
    "document_prd": "design-prd",
    "document_ux": "execute-ux",
}

export function createAutocodeSkillEditTool(fileSystem: FileSystem = defaultFileSystem) {
    return tool({
        description: "Edit main skill file (SKILL.md) body that agent loads via skill tool. Overwrites existing. NOT for reference files. Skill name auto-resolved from calling agent for mapped agents (document_*).",
        args: {
            name: tool.schema.string().describe("Skill name: 4 words max, alpha-numeric and hyphens only."),
            description: tool.schema.string().describe("Trigger description of: situations, symptoms, task that should make agent recall this skill. Use `skill-write` skill to see correct format."),
            content: tool.schema.string().describe("Content in Caveman English. Use `skill-write` skill to see correct format. Do NOT wrap content in XML tags."),
            references: tool.schema.array(tool.schema.object({
                description: tool.schema.string().describe("Short reference description, max 10 words"),
                path: tool.schema.string().describe("Path relative to SKILL.md for this reference file"),
                content: tool.schema.string().describe("File content. Use \"[delete]\" to delete this reference file and remove its entry."),
            })).optional().describe("Optional list of reference files to create/update/delete alongside main SKILL.md"),
        },
        async execute(args, context) {
            // Auto-resolve skill name from calling agent - prevents agents from editing wrong skill
            const mappedName = AGENT_SKILL_MAP[context.agent]
            if (mappedName) {
                args.name = mappedName
            }
            const name = args.name.trim()
            const description = args.description.trim()
            const content = args.content.trim()

            if (!name) {
                return createRetryResponse("edit skill", "Missing skill name.", "Provide a skill name.")
            }
            if (!description) {
                return createRetryResponse("edit skill", "Missing skill description.", "Provide a skill description (trigger).")
            }
            if (!content) {
                return createRetryResponse("edit skill", "Missing skill content.", "Provide a SKILL.md body content.")
            }

            const fileContent = `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`

            if (fileContent.split("\n").length > MAX_LINES) {
                return createRetryResponse(
                    "edit skill",
                    `Skill exceeds ${MAX_LINES} lines.`,
                    "Reduce skill content length.",
                )
            }

            const storageRoot = resolveAgentsStorageRoot(context)
            const skillDir = path.join(storageRoot, ".agents", "skills", name)
            const skillFilePath = path.join(skillDir, "SKILL.md")

            try {
                await fileSystem.mkdir(skillDir, { recursive: true })

                let previousSkillMd = ""
                try {
                    previousSkillMd = await fileSystem.readFile(skillFilePath, "utf8")
                } catch {
                    previousSkillMd = ""
                }

                await fileSystem.writeFile(skillFilePath, fileContent)

                if (args.references && args.references.length > 0) {
                    const changes: Array<{ path: string, description?: string, deleted: boolean }> = []
                    for (const reference of args.references) {
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
            } catch (error) {
                return createAbortResponse("edit skill", error)
            }

            return path.relative(storageRoot, skillFilePath)
        },
    })
}
