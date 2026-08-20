import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { createAbortResponse, createErrorResponse } from "@/utils/tools"
import { stripLeadingYamlFrontMatter } from "@/utils/frontmatter"
import { getRelativeConceptFilePath, isMissingFile, resolveAgentsStorageRoot } from "@/utils/jobs"

type FileSystem = {
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
}

const defaultFileSystem: FileSystem = {
    readFile,
}

function getBacklogPath(worktree: string, label: string): string {
    const conceptsRoot = path.resolve(worktree, ".agents", "concepts")
    const conceptPath = path.resolve(worktree, getRelativeConceptFilePath(label))
    if (!conceptPath.startsWith(`${conceptsRoot}${path.sep}`)) {
        throw new Error(`Invalid concept path: ${label}`)
    }

    return conceptPath
}

function isFileSystem(candidate: OpencodeClient | FileSystem | undefined): candidate is FileSystem {
    return typeof (candidate as { readFile?: unknown } | undefined)?.readFile === "function"
}

function normalizeConceptReadToolArgs(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem): { client?: OpencodeClient, fileSystem: FileSystem } {
    if (maybeFileSystem) {
        return { client: clientOrFileSystem as OpencodeClient | undefined, fileSystem: maybeFileSystem }
    }

    if (isFileSystem(clientOrFileSystem)) {
        return { fileSystem: clientOrFileSystem }
    }

    return { client: clientOrFileSystem as OpencodeClient | undefined, fileSystem: defaultFileSystem }
}

export function createAutocodeConceptReadTool(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem): ReturnType<typeof tool> {
    const { fileSystem } = normalizeConceptReadToolArgs(clientOrFileSystem, maybeFileSystem)

    return tool({
        description: "Read concept content.",
        args: {
            label: tool.schema.string().describe("Label of concept to read."),
        },
        async execute(args, context) {
            const storageRoot = resolveAgentsStorageRoot(context)
            try {
                const conceptPath = getBacklogPath(storageRoot, args.label)
                const conceptContent = await fileSystem.readFile(conceptPath, "utf8")
                return stripLeadingYamlFrontMatter(conceptContent)
            }
            catch (error) {
                if (isMissingFile(error)) {
                    return createErrorResponse("read concept", `Concept not found: ${args.label}`, "Ask the user to choose another concept or provide their requirement directly.")
                }

                return createAbortResponse("read concept", error)
            }
        },
    })
}
