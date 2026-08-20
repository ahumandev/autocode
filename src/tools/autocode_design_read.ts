import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import type { Dirent } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { deriveJobNameFromTitle, findLatestJobDesignFile, getCurrentSessionTitle, resolveAgentsStorageRoot, type JobDesignFileSystem } from "@/utils/jobs"
import { designSections, type DesignSection } from "./autocode_design_write"

type FileSystem = {
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    readdir?: (dirPath: string, options: { withFileTypes: true }) => Promise<Dirent[]>
}

async function readDirectory(dirPath: string, options: { withFileTypes: true }): Promise<Dirent[]> {
    return readdir(dirPath, options)
}

const defaultFileSystem: FileSystem = {
    readFile,
    readdir: readDirectory,
}

function normalizeDesignReadToolArgs(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem): { client?: OpencodeClient, fileSystem: FileSystem } {
    if (maybeFileSystem) {
        return { client: clientOrFileSystem as OpencodeClient | undefined, fileSystem: maybeFileSystem }
    }

    const candidate = clientOrFileSystem as FileSystem | OpencodeClient | undefined
    if (candidate && "readFile" in candidate) {
        return { fileSystem: candidate as FileSystem }
    }

    return { client: candidate as OpencodeClient | undefined, fileSystem: defaultFileSystem }
}

function isCompatibleDesignName(value: string): boolean {
    return /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value) && value.length <= 100
}

export function parseDesignMarkdown(markdown: string): Record<DesignSection, string> {
    const sections = Object.fromEntries(designSections.map((section): [DesignSection, string] => [section, ""])) as Record<DesignSection, string>
    const headings = Array.from(markdown.matchAll(/^#{1,2}\s+(Problems|Impact|Expectations|Requirements|Constraints|Proposal)\s*$/gim))
    for (const [index, heading] of headings.entries()) {
        const section = heading[1].toLowerCase() as DesignSection
        const nextHeading = headings[index + 1]
        sections[section] = markdown.slice(heading.index! + heading[0].length, nextHeading?.index).replace(/^\s*\n/, "").replace(/\n?\s*---\s*$/, "").trim()
    }
    return sections
}

function createDesignReadFileSystem(fileSystem: FileSystem): JobDesignFileSystem {
    return {
        readFile: fileSystem.readFile,
        readdir: fileSystem.readdir ?? readDirectory,
    }
}

function formatDesignSessionTitle(designName: string): string {
    return designName.split("_").map((word: string): string => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")
}

async function updateCurrentSessionTitleToDesignName(client: OpencodeClient | undefined, context: { sessionID: string, directory: string }, designName: string): Promise<void> {
    if (!client) return
    await client.session.update({
        path: { id: context.sessionID },
        query: { directory: context.directory },
        body: { title: formatDesignSessionTitle(designName) },
    })
}

export function createAutocodeDesignReadTool(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem): ReturnType<typeof tool> {
    const { client, fileSystem } = normalizeDesignReadToolArgs(clientOrFileSystem, maybeFileSystem)
    return tool({
        description: "Read design.md from a job workspace.",
        args: {
            job_name: tool.schema.string().optional().describe("Design job_name if known, otherwise omit to infer from current session title."),
        },
        async execute(args, context): Promise<string> {
            const requestedJobName = args.job_name?.trim()
            if (requestedJobName && !isCompatibleDesignName(requestedJobName)) {
                return createRetryResponse(
                    "read design",
                    `Invalid job_name: ${requestedJobName}`,
                    "Provide a safe snake_case job_name containing only lowercase letters, numbers, and underscores."
                )
            }

            try {
                let designName = requestedJobName
                let warning: string | undefined

                if (!designName) {
                    const currentSession = await getCurrentSessionTitle(client, context)
                    if (!currentSession.title) {
                        return createRetryResponse(
                            "read design",
                            "No job_name was found for current session title.",
                            "Provide job_name explicitly."
                        )
                    }

                    designName = deriveJobNameFromTitle(currentSession.title)
                    if (!designName) {
                        return createRetryResponse(
                            "read design",
                            "No job_name was found for current session title.",
                            "Provide job_name explicitly."
                        )
                    }
                    warning = currentSession.warning
                }

                const result = await findLatestJobDesignFile(createDesignReadFileSystem(fileSystem), resolveAgentsStorageRoot(context), designName)
                if (!result) {
                    return createRetryResponse(
                        "read design",
                        `Design not found for job: ${designName}`,
                        "Check job_name or ensure design.md exists under .agents/jobs/{timestamp}_{job_name}/."
                    )
                }

                const sections = parseDesignMarkdown(result.content)
                await updateCurrentSessionTitleToDesignName(client, context, designName)

                return JSON.stringify({
                    job_name: designName,
                    file_path: result.path,
                    problems: sections.problems,
                    impact: sections.impact,
                    expectations: sections.expectations,
                    requirements: sections.requirements,
                    constraints: sections.constraints,
                    proposal: sections.proposal,
                    warning,
                })
            }
            catch (error) {
                return createAbortResponse("read design", error)
            }
        },
    })
}
