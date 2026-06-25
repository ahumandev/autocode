import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises"
import { createRetryResponse } from "@/utils/tools"
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

type HiddenFailureLogTarget = {
    storageRoot?: string
    jobName?: string
    directory?: string
}

function createGenericResponse(): string {
    return JSON.stringify({
        next_action: "Continue with current task.",
    })
}

function appendNextAction(response: string): string {
    const parsed = JSON.parse(response) as Record<string, unknown>
    return JSON.stringify({
        ...parsed,
        next_action: "Retry with a valid job status.",
    })
}

function createNextAction(status: JobStatus): string {
    return status === "shelved"
        ? "Shelve complete; the job has no active lifecycle directory."
        : `Continue the job from status ${status}.`
}

function stringifyUnknownError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack ?? `${error.name}: ${error.message}`
    }

    if (typeof error === "string") {
        return error
    }

    try {
        return JSON.stringify(error)
    }
    catch {
        return String(error)
    }
}

async function logHiddenFailure(fileSystem: JobToolFileSystem, now: () => Date, target: HiddenFailureLogTarget, failedAction: string, error: unknown): Promise<void> {
    if (!target.storageRoot || !target.jobName || !target.directory) {
        return
    }

    try {
        const solution = createSolutionUtils(fileSystem, target.storageRoot, {
            getDirectory: async () => target.directory,
            now,
        })
        await solution.log(target.jobName, SolutionLogEvent.UpdateStatus, "hidden_failure", `Hidden job-status failure while ${failedAction}.`, stringifyUnknownError(error))
    }
    catch {
        // Hidden failure logging must never affect the tool response.
    }
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

function getIdentityHiddenError(identity: PlannedJobIdentityResolution, status: JobStatus): string {
    if (identity.job_name) {
        if (identity.resolution === "collision") {
            return status === "shelved"
                ? `Planned job lifecycle collision while shelving: ${identity.job_name}`
                : `Planned job lifecycle collision while updating status: ${identity.job_name}`
        }
        if (identity.resolution === "missing") {
            return `Planned job lifecycle directory is missing: ${identity.job_name}`
        }
    }

    return "No planned job directory was found in .agents/jobs/* for the current session."
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
                return appendNextAction(requestedStatusResult.error)
            }

            if (!client) {
                return createGenericResponse()
            }

            const hiddenFailureTarget: HiddenFailureLogTarget = {}
            try {
                const storageRoot = resolveAgentsStorageRoot(context)
                hiddenFailureTarget.storageRoot = storageRoot
                const directoryFileSystem = createDirectoryFileSystem(fileSystem)
                const status = requestedStatusResult.status ?? "executing"
                const identity = await resolvePlannedJobIdentity(directoryFileSystem, client, context, { includeShelved: status === "shelved" })
                hiddenFailureTarget.jobName = identity.job_name
                hiddenFailureTarget.directory = identity.resolved_job?.directory ?? identity.collision?.entries[0]?.directory
                if (identity.mode !== "planned" || !identity.job_name || identity.resolution !== "found") {
                    await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "resolve planned job identity", getIdentityHiddenError(identity, status))
                    return createGenericResponse()
                }

                const jobName = identity.job_name
                const resolvedJob = identity.resolved_job
                if (!resolvedJob) {
                    await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "resolve planned job lifecycle details", "Resolved planned-job identity is missing lifecycle details.")
                    return createGenericResponse()
                }
                hiddenFailureTarget.directory = resolvedJob.directory
                if (!directoryFileSystem.rename) {
                    await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "move planned job lifecycle directory", "Unable to move planned job lifecycle directory: rename is unavailable")
                    return createGenericResponse()
                }
                const moveFileSystem = {
                    ...directoryFileSystem,
                    rename: directoryFileSystem.rename,
                }
                const effectiveStatus = getEffectiveJobStatus(status, resolvedJob.status)
                await updateCurrentSessionTitleToJobName(client, context, jobName, effectiveStatus)

                const reportContentResult = await readLatestAssistantResponseText(client, context)
                if (reportContentResult.error) {
                    await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "inspect current session messages", reportContentResult.error)
                    return createGenericResponse()
                }
                if (reportContentResult.limitation) {
                    await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "inspect current session messages", reportContentResult.limitation)
                    return createGenericResponse()
                }
                if (!reportContentResult.text?.trim()) {
                    await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "read latest assistant response text", "No assistant response text was found in the current session.")
                    return createGenericResponse()
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
                        await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "shelve planned job", `Planned job lifecycle directory is missing: ${jobName}`)
                        return createGenericResponse()
                    }
                    if (shelved.type === "collision") {
                        await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "shelve planned job", `Planned job lifecycle collision: ${jobName}`)
                        return createGenericResponse()
                    }
                    if (shelved.type === "destination_collision") {
                        await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "shelve planned job", `Destination lifecycle directory already exists for ${jobName}`)
                        return createGenericResponse()
                    }
                    if (!shelved.sandbox_archive.ok) {
                        await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "archive job sandboxes", shelved.sandbox_archive.reason)
                        return createGenericResponse()
                    }

                    return JSON.stringify({
                        next_action: createNextAction(shelved.moved.job.status),
                    })
                }

                const moved = await movePlannedJobToStatus(storageRoot, jobName, effectiveStatus, moveFileSystem)
                if (moved.type === "missing") {
                    await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "move planned job to status", `Planned job lifecycle directory is missing: ${jobName}`)
                    return createGenericResponse()
                }
                if (moved.type === "collision") {
                    await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "move planned job to status", `Planned job lifecycle collision: ${jobName}`)
                    return createGenericResponse()
                }
                if (moved.type === "destination_collision") {
                    await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "move planned job to status", `Destination lifecycle directory already exists for ${jobName}`)
                    return createGenericResponse()
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
                await logHiddenFailure(fileSystem, now, hiddenFailureTarget, "update job status", error)
                return createGenericResponse()
            }
        },
    })
}
