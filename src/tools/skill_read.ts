import { tool } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import path from "path"
import { isMissingFile, resolveAgentsStorageRoot } from "@/utils/jobs"
import { createRetryResponse } from "@/utils/tools"

type FileSystem = {
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
}

const defaultFileSystem: FileSystem = { readFile }

export function createAutocodeSkillReadTool(fileSystem: FileSystem = defaultFileSystem) {
    return tool({
        description: "ALWAYS preview old skill file content before editing with \`skill_edit\`. ",
        args: {
            name: tool.schema.string().describe("Skill name."),
        },
        async execute(args, context) {
            const name = args.name.trim()

            if (!name) {
                return createRetryResponse("read skill", "Missing skill name.", "Provide a skill name.")
            }

            const storageRoot = resolveAgentsStorageRoot(context)
            const skillDir = path.join(storageRoot, ".agents", "skills", name)
            const skillFilePath = path.join(skillDir, "SKILL.md")

            try {
                return await fileSystem.readFile(skillFilePath, "utf8")
            }
            catch (error) {
                if (isMissingFile(error)) {
                    return `Skill not found: ${name}`
                }
                throw error
            }
        },
    })
}
