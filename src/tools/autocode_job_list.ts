import { tool } from "@opencode-ai/plugin"
import { readdir } from "node:fs/promises"
import { createAbortResponse } from "../utils/tools"
import { listJobWorkspaces, resolveAgentsStorageRoot } from "@/utils/jobs"

type FileSystem = {
    readdir: (dirPath: string, options?: { withFileTypes?: boolean }) => Promise<string[] | import("fs").Dirent[]>
}

async function readDirectory(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | import("fs").Dirent[]> {
    return options?.withFileTypes ? readdir(dirPath, { withFileTypes: true }) : readdir(dirPath)
}

const defaultFileSystem: FileSystem = {
    readdir: readDirectory,
}

export async function executeJobWorkspaceList(fileSystem: FileSystem, worktree: string, options: { resultKey: string, failedAction: string }): Promise<string> {
    try {
        const listed = await listJobWorkspaces(fileSystem, worktree)
        return JSON.stringify({
            [options.resultKey]: listed.jobs.map((workspace) => ({
                job_name: workspace.job_name,
                job_path: workspace.job_path,
            })),
        })
    }
    catch (error) {
        return createAbortResponse(options.failedAction, error)
    }
}

export function createAutocodeJobListTool(fileSystem: FileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return tool({
        description: "List timestamped job workspaces.",
        args: {},
        async execute(_args, context): Promise<string> {
            return executeJobWorkspaceList(fileSystem, resolveAgentsStorageRoot(context), {
                resultKey: "jobs",
                failedAction: "list jobs",
            })
        },
    })
}
