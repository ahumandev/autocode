import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import type { Dirent } from "fs"
import { readFile, readdir } from "fs/promises"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { findExistingJobFile, isCompatibleJobName, resolveAgentsStorageRoot, resolvePlannedJobIdentity, updateCurrentSessionTitleToJobName, type DirectoryFileSystem } from "@/utils/jobs"
import { parsePlanMarkdown } from "./autocode_plan_save"

type FileSystem = {
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    readdir?: (dirPath: string, options: { withFileTypes: true }) => Promise<Dirent[]>
}

type PlanResolverFileSystem = Pick<DirectoryFileSystem, "readFile" | "readdir">

async function readDirectory(dirPath: string, options: { withFileTypes: true }): Promise<Dirent[]> {
    return readdir(dirPath, options)
}

const defaultFileSystem: FileSystem = {
    readFile,
    readdir: readDirectory,
}

function createPlanResolverFileSystem(fileSystem: FileSystem): PlanResolverFileSystem {
    return {
        readFile: fileSystem.readFile,
        readdir: fileSystem.readdir ?? readDirectory,
    }
}

function normalizePlanReadToolArgs(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem): { client?: OpencodeClient, fileSystem: FileSystem } {
    if (maybeFileSystem) {
        return { client: clientOrFileSystem as OpencodeClient | undefined, fileSystem: maybeFileSystem }
    }

    const candidate = clientOrFileSystem as FileSystem | OpencodeClient | undefined
    if (candidate && "readFile" in candidate) {
        return { fileSystem: candidate as FileSystem }
    }

    return { client: candidate as OpencodeClient | undefined, fileSystem: defaultFileSystem }
}

export function createAutocodePlanReadTool(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem): ReturnType<typeof tool> {
    const { client, fileSystem } = normalizePlanReadToolArgs(clientOrFileSystem, maybeFileSystem)
    return tool({
        description: "Read your solution plan of your job.",
        args: {
            job_name: tool.schema.string().optional().describe("Planned job_name if known, otherwise omit to look it up."),
        },
        async execute(args, context) {
            const requestedJobName = args.job_name?.trim()
            if (requestedJobName && !isCompatibleJobName(requestedJobName)) {
                return createRetryResponse(
                    "read plan",
                    `Invalid job_name: ${requestedJobName}`,
                    "Provide a safe snake_case job_name containing only lowercase letters, numbers, and underscores."
                )
            }

            try {
                let jobName = requestedJobName
                let warning: string | undefined

                if (!jobName) {
                    const identity = await resolvePlannedJobIdentity(createPlanResolverFileSystem(fileSystem), client, context)
                    if (identity.mode !== "planned" || !identity.job_name) {
                        return createRetryResponse(
                            "read plan",
                            "No job_name was found for current session.",
                            "Provide job_name explicitly."
                        )
                    }

                    jobName = identity.job_name
                    warning = identity.warning
                }

                const result = await findExistingJobFile(fileSystem, resolveAgentsStorageRoot(context), jobName, "plan.md")
                if (!result) {
                    return createRetryResponse(
                        "read plan",
                        `Plan not found for job: ${jobName}`,
                        "Check job_name or tell user to ensure plan.md exists under .agents/jobs/{status}/{job_name}/plan.md"
                    )
                }

                const plan = result.content
                const sections = parsePlanMarkdown(plan)
                await updateCurrentSessionTitleToJobName(client, context, jobName)

                return JSON.stringify({
                    job_name: jobName,
                    file_path: result.path,
                    problems: sections.problems,
                    requirements: sections.requirements,
                    constraints: sections.constraints,
                    risks: sections.risks,
                    proposal: sections.proposal,
                    warning,
                })
            }
            catch (error) {
                return createAbortResponse("read plan", error)
            }
        },
    })
}
