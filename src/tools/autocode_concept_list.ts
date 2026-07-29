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

type ConceptListEntry = {
    label: string
    path: string
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

async function readDescription(fileSystem: FileSystem, filePath: string): Promise<string> {
    try {
        return getDescription(await fileSystem.readFile(filePath, "utf8"))
    }
    catch (error) {
        if (isMissingFile(error)) return ""
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
                const storageRoot = resolveAgentsStorageRoot(context)
                const conceptEntries = (await readDirectoryEntries(fileSystem, conceptsDirectory))
                    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
                    .map((entry): ConceptListEntry => ({
                        label: entry.name.slice(0, -3),
                        path: path.join(conceptsDirectory, entry.name),
                    }))
                const jobEntries = (await Promise.all(["drafts", "executing", "facilitate"].map(async (directory) => {
                    const jobDirectory = path.join(storageRoot, ".agents", "jobs", directory)
                    return (await readDirectoryEntries(fileSystem, jobDirectory))
                        .filter((entry) => entry.isDirectory())
                        .map((entry): ConceptListEntry => ({
                            label: entry.name,
                            path: path.join(jobDirectory, entry.name, "plan.md"),
                        }))
                }))).flat()
                const backlog = await Promise.all([...conceptEntries, ...jobEntries]
                    .sort((left, right) => left.label.localeCompare(right.label) || left.path.localeCompare(right.path))
                    .map(async (entry) => ({
                        label: entry.label,
                        description: await readDescription(fileSystem, entry.path),
                    })))

                return JSON.stringify({ backlog })
            }
            catch (error) {
                return createAbortResponse("list concepts", error)
            }
        },
    })
}
