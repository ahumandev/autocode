import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises"
import { createAbortResponse, createLifecycleJobRequiredRetryResponse, createRetryResponse } from "@/utils/tools"
import { createDirectoryFileSystem, getEffectiveJobStatus, isJobStatus, movePlannedJobToStatus, readLatestAssistantResponseText, resolveAgentsStorageRoot, resolvePlannedJobIdentity, updateCurrentSessionTitleToJobName, type JobStatus, type JobToolFileSystem, type PlannedJobIdentityResolution } from "@/utils/jobs"
import { createSolutionUtils, SolutionLogEvent } from "@/utils/solution"
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

function normalizeJobStatusToolArgs(clientOrFileSystem?: OpencodeClient | JobToolFileSystem, fileSystemOrNow?: JobToolFileSystem | (() => Date), maybeNow?: () => Date): { client?: OpencodeClient, fileSystem: JobToolFileSystem, now: () => Date } {
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

function createNoopResponse(): string {
    return JSON.stringify({})
}

function createCollisionRetryResponse(jobName: string, status: JobStatus): string {
    return createRetryResponse(
        "update job status",
        `Planned job lifecycle collision: ${jobName}`,
        status === "shelved" ? "Resolve duplicate active lifecycle directories for this job before shelving." : "Resolve duplicate active lifecycle directories for this job before retrying."
    )
}

function createNextAction(status: JobStatus): string {
    return status === "shelved"
        ? "Shelve complete; the job has no active lifecycle directory."
        : `Continue the job from status ${status}.`
}

function createMissingIdentityRetryResponse(): string {
    return createLifecycleJobRequiredRetryResponse("update job status")
}

function getRequestedStatus(args: Record<string, unknown>): { status?: JobStatus, error?: string } {
    const requestedStatus = typeof args.status === "string" ? args.status.trim() : undefined

    if (requestedStatus) {
        const normalizedStatus = requestedStatus.toLowerCase()
        if (!isJobStatus(normalizedStatus)) {
            return {
                error: createRetryResponse(
                    "update job status",
                    `Invalid status: ${args.status}`,
                    "Use one of: concepts, drafts, assist, executing, facilitate, review, shelved."
                )
            }
        }

        return { status: normalizedStatus }
    }

    return {
        error: createRetryResponse(
            "update job status",
            `Invalid status: ${args.status}`,
            "Use one of: concepts, drafts, assist, executing, facilitate, review, shelved."
        )
    }
}

function getIdentityResponse(identity: PlannedJobIdentityResolution, status: JobStatus): string {
    if (identity.job_name) {
        if (identity.resolution === "collision") {
            return createCollisionRetryResponse(identity.job_name, status)
        }
        if (identity.resolution === "missing") {
            return createNoopResponse()
        }
    }

    return createMissingIdentityRetryResponse()
}

export function createAutocodeJobStatusTool(clientOrFileSystem?: OpencodeClient | JobToolFileSystem, fileSystemOrNow?: JobToolFileSystem | (() => Date), maybeNow?: () => Date): ReturnType<typeof tool> {
    const { client, fileSystem, now } = normalizeJobStatusToolArgs(clientOrFileSystem, fileSystemOrNow, maybeNow)
    return tool({
        description: "Update canonical lifecycle statuses for jobs under .agents/jobs/*.",
        args: {
            status: tool.schema.string().optional().describe("concepts, drafts, assist, executing, facilitate, review, shelved"),
        },
        async execute(args, context) {
            const requestedStatusResult = getRequestedStatus(args as Record<string, unknown>)
            if (requestedStatusResult.error) {
                return requestedStatusResult.error
            }

            if (!client) {
                return createAbortResponse("update job status", "Opencode client is unavailable.")
            }

            try {
                const storageRoot = resolveAgentsStorageRoot(context)
                const directoryFileSystem = createDirectoryFileSystem(fileSystem)
                const status = requestedStatusResult.status!
                const identity = await resolvePlannedJobIdentity(directoryFileSystem, client, context, { includeShelved: status === "shelved" })
                if (identity.mode !== "planned" || !identity.job_name) {
                    return getIdentityResponse(identity, status)
                }

                const jobName = identity.job_name
                const resolvedJob = identity.resolved_job
                if (!resolvedJob) {
                    return createAbortResponse("update job status", "Resolved planned-job identity is missing lifecycle details.")
                }
                if (!directoryFileSystem.rename) {
                    return createAbortResponse("update job status", "Unable to move planned job lifecycle directory: rename is unavailable")
                }
                const moveFileSystem = {
                    ...directoryFileSystem,
                    rename: directoryFileSystem.rename,
                }
                const effectiveStatus = getEffectiveJobStatus(status, resolvedJob.status)
                const title = await updateCurrentSessionTitleToJobName(client, context, jobName, effectiveStatus)

                const reportContentResult = await readLatestAssistantResponseText(client, context)
                if (reportContentResult.error) {
                    return createAbortResponse("inspect current session messages", reportContentResult.error)
                }
                if (reportContentResult.limitation) {
                    return createAbortResponse("inspect current session messages", reportContentResult.limitation)
                }
                if (!reportContentResult.text?.trim()) {
                    return createRetryResponse(
                        "update job status",
                        "No assistant response text was found in the current session.",
                        "First present the user-facing lifecycle update in assistant text with concrete actions and a separate reason/evidence summary, then call autocode_job_status again."
                    )
                }

                if (effectiveStatus === "shelved") {
                    const shelved = await shelveResolvedPlannedJob({
                        storageRoot,
                        client: undefined,
                        context,
                        fileSystem,
                        moveFileSystem,
                        now,
                        resolvedJob,
                        assistantResponseText: reportContentResult.text,
                    })
                    if (shelved.type === "missing") {
                        return createNoopResponse()
                    }
                    if (shelved.type === "collision") {
                        return createCollisionRetryResponse(jobName, effectiveStatus)
                    }
                    if (shelved.type === "destination_collision") {
                        return createRetryResponse("update job status", `Destination lifecycle directory already exists for ${jobName}`, "Resolve the existing lifecycle directory collision before shelving.")
                    }
                    if (!shelved.sandbox_archive.ok) {
                        return createRetryResponse("archive job sandboxes", shelved.sandbox_archive.reason, "Resolve the sandbox archive collision or unsafe path before retrying. Do not overwrite existing sandbox archives.")
                    }

                    return JSON.stringify({
                        next_action: createNextAction(shelved.moved.job.status),
                    })
                }

                const moved = await movePlannedJobToStatus(storageRoot, jobName, effectiveStatus, moveFileSystem)
                if (moved.type === "missing") {
                    return createNoopResponse()
                }
                if (moved.type === "collision") {
                    return createCollisionRetryResponse(jobName, effectiveStatus)
                }
                if (moved.type === "destination_collision") {
                    return createRetryResponse("update job status", `Destination lifecycle directory already exists for ${jobName}`, "Resolve the existing lifecycle directory collision before retrying.")
                }

                const solution = createSolutionUtils(fileSystem, storageRoot, {
                    getDirectory: async () => moved.job.directory,
                    now,
                })
                await solution.log(jobName, SolutionLogEvent.UpdateStatus, moved.job.status, reportContentResult.text, reportContentResult.text)

                return JSON.stringify({
                    next_action: createNextAction(moved.job.status),
                })
            }
            catch (error) {
                return createAbortResponse("update job status", error)
            }
        },
    })
}
