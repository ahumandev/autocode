import { tool } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import path from "path"
import { isMissingFile, resolveAgentsStorageRoot } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type FileSystem = {
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
}

const defaultFileSystem: FileSystem = { readFile }

export function createSkillReadReferenceTool(fileSystem: FileSystem = defaultFileSystem) {
    return tool({
        description: "Call skill_read_reference to read file referenced by skill like templates, scripts, configs, extra md details. NOT for reading main skill (SKILL.md) file.",
        args: {
            skill_name: tool.schema
                .string()
                .describe("Skill name that contains reference links in skill content."),
            skill_link: tool.schema
                .string()
                .describe(
                    "Relative file path matching link in SKILL.md content exactly. Example: reference/template.xml",
                ),
        },
        async execute(args, context) {
            const skillName = args.skill_name.trim()
            const skillLink = args.skill_link.trim()

            if (!skillName) {
                return createRetryResponse("read skill file", "Missing skill name.", "Provide a skill name.")
            }
            if (!skillLink) {
                return createRetryResponse(
                    "read skill file",
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
                    "read skill file",
                    `Invalid skill_name: "${skillName}" escapes the skills directory.`,
                    "Provide a skill_name that resolves within .agents/skills/.",
                )
            }

            const relativeToSkill = path.relative(skillDir, targetFilePath)
            if (!relativeToSkill || relativeToSkill.startsWith("..") || path.isAbsolute(relativeToSkill)) {
                return createRetryResponse(
                    "read skill file",
                    `Invalid skill_link: "${skillLink}" escapes the skill directory.`,
                    "Provide a skill_link that resolves within .agents/skills/{skill_name}/.",
                )
            }

            try {
                return await fileSystem.readFile(targetFilePath, "utf8")
            }
            catch (error) {
                if (isMissingFile(error)) {
                    return createAbortResponse("read skill file", `File not found: ${skillLink}`)
                }
                return createAbortResponse("read skill file", error)
            }
        },
    })
}
