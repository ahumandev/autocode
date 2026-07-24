import { tool } from "@opencode-ai/plugin"
import { readFile, readdir } from "node:fs/promises"
import type { Dirent } from "node:fs"
import path from "node:path"
import { createAbortResponse } from "@/utils/tools"
import { stripLeadingYamlFrontMatter } from "@/utils/frontmatter"
import { isMissingFile, resolveAgentsStorageRoot } from "@/utils/jobs"

type FileSystem = {
    readdir: (filePath: string, options: { withFileTypes: true }) => Promise<Dirent[]>
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
}

const defaultFileSystem: FileSystem = {
    readdir,
    readFile,
}

function getDescription(source: string): string {
    const line = stripLeadingYamlFrontMatter(source).split(/\r?\n/).map((line) => line.trim()).find((line) => !/^#{1,6}\s+/.test(line) && /[a-z0-9]/i.test(line)) ?? ""
    return line.length > 160 ? `${line.slice(0, 160)}...` : line
}

async function readDirectoryEntries(fileSystem: FileSystem, directory: string): Promise<Dirent[]> {
    try {
        return await fileSystem.readdir(directory, { withFileTypes: true })
    }
    catch (error) {
        if (isMissingFile(error)) return []
        throw error
    }
}

export function createAutocodeConceptListTool(fileSystem: FileSystem = defaultFileSystem) {
    return tool({
        description: "List available concepts.",
        args: {},
        async execute(_, context) {
            const conceptsDirectory = path.join(resolveAgentsStorageRoot(context), ".agents", "jobs", "concepts")
            try {
                const entries = await readDirectoryEntries(fileSystem, conceptsDirectory)
                const backlog = await Promise.all(entries
                    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
                    .map((entry) => entry.name)
                    .sort((left, right) => left.localeCompare(right))
                    .map(async (fileName) => {
                        const source = await fileSystem.readFile(path.join(conceptsDirectory, fileName), "utf8")
                        return {
                            label: fileName.slice(0, -3),
                            description: getDescription(source),
                        }
                    }))

                return JSON.stringify({ backlog })
            }
            catch (error) {
                return createAbortResponse("list concepts", error)
            }
        },
    })
}
