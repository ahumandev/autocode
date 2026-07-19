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

const MAX_LINES = 500

export function createAutocodeSkillEditTool(fileSystem: FileSystem = defaultFileSystem) {
    return tool({
        description: "Edit main skill file (SKILL.md) body that agent loads via skill tool. Overwrites existing. NOT for reference files.",
        args: {
            name: tool.schema.string().describe("Skill name: 4 words max, alpha-numeric and hyphens only."),
            description: tool.schema.string().describe("Trigger description of: situations, symptoms, task that should make agent recall this skill. Use `skill-write` skill to see correct format."),
            content: tool.schema.string().describe("Content in Caveman English. Use `skill-write` skill to see correct format."),
        },
        async execute(args, context) {
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
                await fileSystem.writeFile(skillFilePath, fileContent)
            } catch (error) {
                return createAbortResponse("edit skill", error)
            }

            return path.relative(storageRoot, skillFilePath)
        },
    })
}
