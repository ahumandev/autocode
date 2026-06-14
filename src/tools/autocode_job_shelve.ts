import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises"
import { createAbortResponse, createLifecycleJobRequiredRetryResponse, createRetryResponse } from "@/utils/tools"
import { createDirectoryFileSystem, readLatestAssistantResponseText, resolveAgentsStorageRoot, resolvePlannedJobIdentity, type JobToolFileSystem, type PlannedJobIdentityResolution } from "@/utils/jobs"
import { shelveResolvedPlannedJob } from "@/utils/shelve"

async function readDirectory(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | import("fs").Dirent[]> {
    return options?.withFileTypes ? readdir(dirPath, { withFileTypes: true }) : readdir(dirPath)
}

const defaultFileSystem: JobToolFileSystem = {
    mkdir,
    readFile,
    readdir: readDirectory,
    rename,
    rm,
    stat,
    writeFile,
}

function normalizeShelveToolArgs(clientOrFileSystem?: OpencodeClient | JobToolFileSystem, fileSystemOrNow?: JobToolFileSystem | (() => Date), maybeNow?: () => Date): { client?: OpencodeClient, fileSystem: JobToolFileSystem, now: () => Date } {
    if (typeof fileSystemOrNow === "function") {
        return { fileSystem: (clientOrFileSystem as JobToolFileSystem | undefined) ?? defaultFileSystem, now: fileSystemOrNow }
    }
    if (fileSystemOrNow) {
        return { client: clientOrFileSystem as OpencodeClient | undefined, fileSystem: fileSystemOrNow, now: maybeNow ?? (() => new Date()) }
    }
    const candidate = clientOrFileSystem as JobToolFileSystem | OpencodeClient | undefined
    if (candidate && "readFile" in candidate && "writeFile" in candidate) {
        return { fileSystem: candidate as JobToolFileSystem, now: () => new Date() }
    }
    return { client: candidate as OpencodeClient | undefined, fileSystem: defaultFileSystem, now: () => new Date() }
}

function createMissingIdentityRetryResponse(): string {
    return createLifecycleJobRequiredRetryResponse("shelve job")
}

function createMissingJobRetryResponse(jobName: string): string {
    return createLifecycleJobRequiredRetryResponse("shelve job", `job ${jobName}`)
}

function getIdentityRetryResponse(identity: PlannedJobIdentityResolution): string {
    if (identity.job_name) {
        if (identity.resolution === "collision") {
            return createRetryResponse("shelve job", `Planned job lifecycle collision: ${identity.job_name}`, "Resolve duplicate active lifecycle directories for this job before shelving.")
        }
        if (identity.resolution === "missing") {
            return createMissingJobRetryResponse(identity.job_name)
        }
    }

    return createMissingIdentityRetryResponse()
}

export function createAutocodeJobShelveTool(clientOrFileSystem?: OpencodeClient | JobToolFileSystem, fileSystemOrNow?: JobToolFileSystem | (() => Date), maybeNow?: () => Date): ReturnType<typeof tool> {
    const { client, fileSystem, now } = normalizeShelveToolArgs(clientOrFileSystem, fileSystemOrNow, maybeNow)
    return tool({
        description: "Shelve current lifecycle job into .agents/jobs/shelved/{name}/.",
        args: {},
        async execute(_args, context) {
            if (!client) {
                return createMissingIdentityRetryResponse()
            }

            try {
                const storageRoot = resolveAgentsStorageRoot(context)
                const directoryFileSystem = createDirectoryFileSystem(fileSystem)
                const identity = await resolvePlannedJobIdentity(directoryFileSystem, client, context, { includeShelved: true })
                if (identity.mode !== "planned" || !identity.job_name) {
                    return getIdentityRetryResponse(identity)
                }

                const jobName = identity.job_name
                const resolvedJob = identity.resolved_job
                if (!resolvedJob) {
                    return createAbortResponse("shelve job", "Resolved planned-job identity is missing lifecycle details.")
                }
                if (!directoryFileSystem.rename) {
                    return createAbortResponse("shelve job", "Unable to move planned job lifecycle directory: rename is unavailable")
                }

                const reportContentResult = await readLatestAssistantResponseText(client, context)
                if (reportContentResult.error) {
                    return createAbortResponse("inspect current session messages", reportContentResult.error)
                }
                if (reportContentResult.limitation) {
                    return createAbortResponse("inspect current session messages", reportContentResult.limitation)
                }
                if (!reportContentResult.text?.trim()) {
                    return createRetryResponse(
                        "shelve job",
                        "No assistant response text was found in the current session.",
                        "First present the user-facing lifecycle update in assistant text with concrete actions and a separate reason/evidence summary, then call autocode_job_shelve again."
                    )
                }

                const shelved = await shelveResolvedPlannedJob({
                    storageRoot,
                    client,
                    context,
                    fileSystem,
                    moveFileSystem: { ...directoryFileSystem, rename: directoryFileSystem.rename },
                    now,
                    resolvedJob,
                    assistantResponseText: reportContentResult.text,
                })
                if (shelved.type === "missing") {
                    return createMissingJobRetryResponse(jobName)
                }
                if (shelved.type === "collision") {
                    return createRetryResponse("shelve job", `Planned job lifecycle collision: ${jobName}`, "Resolve duplicate active lifecycle directories for this job before shelving.")
                }
                if (shelved.type === "destination_collision") {
                    return createRetryResponse("shelve job", `Destination lifecycle directory already exists for ${jobName}`, "Resolve the existing lifecycle directory collision before shelving.")
                }
                if (!shelved.sandbox_archive.ok) {
                    return createRetryResponse("archive job sandboxes", shelved.sandbox_archive.reason, "Resolve the sandbox archive collision or unsafe path before retrying. Do not overwrite existing sandbox archives.")
                }

                return JSON.stringify({
                    job_name: shelved.moved.job.job_name,
                    current_status: "shelved",
                    job_path: shelved.moved.job.job_path,
                    solution_path: shelved.solution.relativeSolutionPath,
                    sandbox_archive: shelved.sandbox_archive,
                    title_warning: shelved.title.warning,
                    next_action: "Shelve complete; the job has no active lifecycle directory.",
                })
            }
            catch (error) {
                return createAbortResponse("shelve job", error)
            }
        },
    })
}
