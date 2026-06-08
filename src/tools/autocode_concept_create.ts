import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, stat, writeFile } from "fs/promises"
import path from "path"
import { getCurrentSessionTitle, getRelativeConceptFilePath, isMissingFile, resolveAgentsStorageRoot } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type FileSystem = {
    mkdir: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>
    stat: (filePath: string) => Promise<{ mtimeMs: number }>
    writeFile: (filePath: string, content: string) => Promise<void>
}

const defaultFileSystem: FileSystem = {
    mkdir,
    stat,
    writeFile,
}

function formatLocalTimestamp(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatFrontMatterValue(value: string): string {
    return JSON.stringify(value)
}

function buildConceptFrontMatter(metadata: {
    sessionTitle: string
    directory: string
    createdAt: string
    conceptTitle: string
}): string {
    return [
        "---",
        `source session title: ${formatFrontMatterValue(metadata.sessionTitle)}`,
        `source directory: ${formatFrontMatterValue(metadata.directory)}`,
        `create: ${formatFrontMatterValue(metadata.createdAt)}`,
        `concept title: ${formatFrontMatterValue(metadata.conceptTitle)}`,
        "---",
    ].join("\n")
}

function deriveSlug(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 70)
}

async function resolveAvailableBacklogPath(fileSystem: FileSystem, worktree: string, baseLabel: string): Promise<{ filePath: string, label: string }> {
    const backlogDirectory = path.resolve(worktree, ".agents", "jobs", "concepts")

    for (let attempt = 0; attempt < 1000; attempt++) {
        const label = attempt === 0 ? baseLabel : `${baseLabel}_${attempt + 1}`
        const filePath = path.resolve(backlogDirectory, `${label}.md`)
        const relativePath = path.relative(backlogDirectory, filePath)

        if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
            throw new Error(`Invalid backlog label: ${label}`)
        }

        try {
            await fileSystem.stat(filePath)
        }
        catch (error) {
            if (isMissingFile(error)) {
                return { filePath, label }
            }

            throw error
        }
    }

    throw new Error(`Unable to allocate backlog path for ${baseLabel}`)
}

export function createAutocodeConceptCreateTool(
    client?: OpencodeClient,
    fileSystem: FileSystem = defaultFileSystem,
    getNow: () => Date = () => new Date(),
) {
    return tool({
        description: "Create one concept Markdown file in .agents/jobs/concepts/ from a title or label and raw Markdown body.",
        args: {
            label: tool.schema.string().optional().describe("Summarize concept in < 10 words."),
            concept: tool.schema.string().describe("Complete concept formatted in Markdown."),
        },
        async execute(args, context) {
            const sourceLabel = args.label?.trim()
            if (!sourceLabel) {
                return createRetryResponse(
                    "create concept",
                    "Missing required argument: label",
                    "Provide a label before creating a concept."
                )
            }

            if (!args.concept?.trim()) {
                return createRetryResponse(
                    "create concept",
                    "Missing required argument: concept",
                    "Provide the concept Markdown body before creating a concept."
                )
            }

            const baseLabel = deriveSlug(sourceLabel)
            if (!baseLabel) {
                return createRetryResponse(
                    "create concept",
                    `Unable to derive safe concept label from: ${sourceLabel}`,
                    "Provide a label containing letters or numbers."
                )
            }

            const storageRoot = resolveAgentsStorageRoot(context)
            const backlogDirectory = path.join(storageRoot, ".agents", "jobs", "concepts")

            try {
                await fileSystem.mkdir(backlogDirectory, { recursive: true })
                const target = await resolveAvailableBacklogPath(fileSystem, storageRoot, baseLabel)
                const sessionTitle = await getCurrentSessionTitle(client, context)
                const frontMatter = buildConceptFrontMatter({
                    sessionTitle: sessionTitle.title ?? "",
                    directory: path.resolve(context.directory),
                    createdAt: formatLocalTimestamp(getNow()),
                    conceptTitle: sourceLabel,
                })
                await fileSystem.writeFile(target.filePath, `${frontMatter}\n\n${args.concept}`)

                return JSON.stringify({
                    label: target.label,
                    file_path: getRelativeConceptFilePath(target.label),
                })
            }
            catch (error) {
                return createAbortResponse("create concept", error)
            }
        },
    })
}
