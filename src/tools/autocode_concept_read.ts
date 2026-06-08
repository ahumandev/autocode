import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, rename, writeFile } from "fs/promises"
import path from "path"
import { createAbortResponse, createErrorResponse } from "@/utils/tools"
import { stripLeadingYamlFrontMatter } from "@/utils/frontmatter"
import { deriveJobNameFromTitle, getRelativeConceptFilePath, isMissingFile, resolveAgentsStorageRoot, updateCurrentSessionTitleToJobName } from "@/utils/jobs"

type FileSystem = {
    mkdir?: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    rename?: (oldPath: string, newPath: string) => Promise<void>
    writeFile?: (filePath: string, content: string) => Promise<void>
}

const defaultFileSystem: FileSystem = {
    mkdir,
    readFile,
    rename,
    writeFile,
}

function getBacklogPath(worktree: string, label: string): string {
    return path.join(worktree, getRelativeConceptFilePath(label))
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

export function createAutocodeConceptReadTool(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem) {
    const { client, fileSystem } = normalizeConceptReadToolArgs(clientOrFileSystem, maybeFileSystem)

    return tool({
        description: "Read concept content.",
        args: {
            label: tool.schema.string().describe("Label of concept to read."),
        },
        async execute(args, context) {
            try {
                const storageRoot = resolveAgentsStorageRoot(context)
                const conceptPath = getBacklogPath(storageRoot, args.label)
                const conceptContent = await fileSystem.readFile(conceptPath, "utf8")
                const jobName = deriveJobNameFromTitle(args.label.replace(/\.md$/i, ""))

                if (!jobName) {
                    return createErrorResponse("read concept", `Unable to derive job_name from concept label: ${args.label}`, "Rename the concept label to include letters or numbers.")
                }

                const draftDirectory = path.join(storageRoot, ".agents", "jobs", "drafts", jobName)
                await (fileSystem.mkdir ?? (async () => { throw new Error("File system mkdir is unavailable.") }))(draftDirectory, { recursive: true })
                await (fileSystem.rename ?? (async () => { throw new Error("File system rename is unavailable.") }))(conceptPath, path.join(draftDirectory, "concept.md"))
                await updateCurrentSessionTitleToJobName(client, context, jobName)

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
