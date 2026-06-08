import { tool } from "@opencode-ai/plugin"
import { readFile, readdir } from "fs/promises"
import { createAbortResponse, createRetryResponse } from "../utils/tools"
import { formatPlannedJobCollisions, listPlannedJobs, listedActiveJobStatuses, normalizeJobStatusInput, resolveAgentsStorageRoot, type JobStatus } from "@/utils/jobs"

type FileSystem = {
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    readdir: (dirPath: string, options?: { withFileTypes?: boolean }) => Promise<string[] | import("fs").Dirent[]>
}

async function readDirectory(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | import("fs").Dirent[]> {
    return options?.withFileTypes ? readdir(dirPath, { withFileTypes: true }) : readdir(dirPath)
}

const defaultFileSystem: FileSystem = {
    readFile,
    readdir: readDirectory,
}

export async function executePlannedJobList(fileSystem: FileSystem, worktree: string, options: { resultKey: string, failedAction: string, filter?: JobStatus }): Promise<string> {
    try {
        const listed = await listPlannedJobs(fileSystem, worktree, { filter: options.filter })
        if (listed.collisions.length > 0) {
            return createRetryResponse(
                options.failedAction,
                `Active lifecycle collisions detected: ${formatPlannedJobCollisions(listed.collisions)}`,
                "Resolve the duplicate active lifecycle directories for the named job(s) before retrying."
            )
        }

        return JSON.stringify({
            [options.resultKey]: listed.jobs,
        })
    }
    catch (error) {
        return createAbortResponse(options.failedAction, error)
    }
}

export function createAutocodeJobListTool(fileSystem: FileSystem = defaultFileSystem) {
    return tool({
        description: "List active drafts/jobs.",
        args: {
            filter: tool.schema.string().optional().describe("Optional filter limits results to one active status; omit to list all active jobs. Omit to view all or provide one of these status filters: concepts, drafts, assist, executing, facilitate, review"),
        },
        async execute(args, context) {
            const requestedFilter = args.filter
            const filter = requestedFilter === "" || requestedFilter === undefined
                ? undefined
                : normalizeJobStatusInput(requestedFilter)

            if (requestedFilter !== "" && requestedFilter !== undefined && (filter === undefined || !(listedActiveJobStatuses as readonly string[]).includes(filter))) {
                return createRetryResponse(
                    "list jobs",
                    `Invalid filter: ${requestedFilter}`,
                    "Omit to view all or provide one of these status filters: concepts, drafts, assist, executing, facilitate, review"
                )
            }

            return executePlannedJobList(fileSystem, resolveAgentsStorageRoot(context), {
                resultKey: "jobs",
                failedAction: "list jobs",
                filter: filter as JobStatus | undefined,
            })
        },
    })
}
