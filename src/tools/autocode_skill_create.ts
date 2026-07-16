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

function buildSkillContent(name: string, description: string): string {
    return [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        "---",
        "",
        "# [ACTION]",
        "",
        "[TRIGGER]",
        "",
        "---",
        "",
        "[CONTENT]",
        "",
        "---",
        "",
        "[RULES]",
        "",
    ].join("\n")
}

export function createAutocodeSkillCreateTool(fileSystem: FileSystem = defaultFileSystem) {
    return tool({
        description: "Create skill file.",
        args: {
            name: tool.schema.string().describe("Skill name: 4 words max, alpha-numeric and hyphens only."),
            description: tool.schema.string().describe("Skill trigger. ONLY text LLM reads to decide load skill - bad description = skill never triggers. Minimal Caveman English words, max 100 words."),
        },
        async execute(args, context) {
            const name = args.name.trim()
            const description = args.description.trim()

            if (!name) {
                return createRetryResponse("create skill", "Missing skill name.", "Provide a skill name.")
            }
            if (!description) {
                return createRetryResponse("create skill", "Missing skill description.", "Provide a skill description (trigger).")
            }

            const content = buildSkillContent(name, description)

            if (content.split("\n").length > MAX_LINES) {
                return createRetryResponse(
                    "create skill",
                    `Skill exceeds ${MAX_LINES} lines.`,
                    "Reduce skill content length.",
                )
            }

            const storageRoot = resolveAgentsStorageRoot(context)
            const skillDir = path.join(storageRoot, ".agents", "skills", name)
            const skillFilePath = path.join(skillDir, "SKILL.md")

            try {
                await fileSystem.mkdir(skillDir, { recursive: true })
                await fileSystem.writeFile(skillFilePath, content)
            } catch (error) {
                return createAbortResponse("create skill", error)
            }

            return path.relative(storageRoot, skillFilePath)
        },
    })
}
