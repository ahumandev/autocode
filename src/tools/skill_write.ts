import { tool } from "@opencode-ai/plugin"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { resolveAgentsStorageRoot } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type FileSystem = {
    mkdir: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>
    writeFile: (filePath: string, content: string) => Promise<void>
}

const defaultFileSystem: FileSystem = { mkdir, writeFile }

export function createSkillWriteTool(fileSystem: FileSystem = defaultFileSystem) {
    return tool({
        description: "Call skill_write to write file referenced by skill like templates, scripts, configs, extra md details to keep main SKILL.md lean. NOT for creating main skill (SKILL.md) file.",
        args: {
            skill_name: tool.schema
                .string()
                .describe("Skill name that contains reference links in skill content."),
            skill_link: tool.schema
                .string()
                .describe(
                    "Relative file path matching link in SKILL.md content exactly. Example: reference/template.xml",
                ),
            content: tool.schema.string().describe("Text file content to write."),
        },
        async execute(args, context) {
            const skillName = args.skill_name.trim()
            const skillLink = args.skill_link.trim()
            const content = args.content ?? ""

            if (!skillName) {
                return createRetryResponse("write skill file", "Missing skill name.", "Provide a skill name.")
            }
            if (!skillLink) {
                return createRetryResponse(
                    "write skill file",
                    "Missing skill link.",
                    "Provide a skill link (relative path including filename).",
                )
            }

            const storageRoot = resolveAgentsStorageRoot(context)
            const skillsRoot = path.join(storageRoot, ".agents", "skills")
            const skillDir = path.join(skillsRoot, skillName)
            const targetFilePath = path.resolve(skillDir, skillLink)

            const relativeSkillDir = path.relative(skillsRoot, skillDir)
            if (!relativeSkillDir || relativeSkillDir.startsWith("..") || path.isAbsolute(relativeSkillDir)) {
                return createRetryResponse(
                    "write skill file",
                    `Invalid skill_name: "${skillName}" escapes the skills directory.`,
                    "Provide a skill_name that resolves within .agents/skills/.",
                )
            }

            const relativeToSkill = path.relative(skillDir, targetFilePath)
            if (!relativeToSkill || relativeToSkill.startsWith("..") || path.isAbsolute(relativeToSkill)) {
                return createRetryResponse(
                    "write skill file",
                    `Invalid skill_link: "${skillLink}" escapes the skill directory.`,
                    "Provide a skill_link that resolves within .agents/skills/{skill_name}/.",
                )
            }

            try {
                await fileSystem.mkdir(path.dirname(targetFilePath), { recursive: true })
                await fileSystem.writeFile(targetFilePath, content)
            } catch (error) {
                return createAbortResponse("write skill file", error)
            }

            return path.relative(storageRoot, targetFilePath)
        },
    })
}
