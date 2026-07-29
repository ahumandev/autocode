import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { createRetryResponse } from "@/utils/tools"
import { createDirectoryFileSystem, getEffectiveJobStatus, isJobStatus, movePlannedJobToStatus, resolveAgentsStorageRoot, resolvePlannedJobIdentity, updateCurrentSessionTitleToJobName, type JobStatus, type JobToolFileSystem } from "@/utils/jobs"
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

const jobStatusDescription = "drafts, executing, facilitate, review, shelved"
const jobStatusInstruction = `Use one of: ${jobStatusDescription}.`

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

function getRequestedStatus(args: Record<string, unknown>): { status?: JobStatus, error?: string } {
    const requestedStatus = typeof args.status === "string" ? args.status.trim() : undefined

    if (requestedStatus) {
        const normalizedStatus = requestedStatus.toLowerCase()
        if (!isJobStatus(normalizedStatus)) {
            return {
                error: createRetryResponse(
                    "update job status",
                    `Invalid status: ${args.status}`,
                    jobStatusInstruction
                )
            }
        }

        return { status: normalizedStatus }
    }

    return {
        error: createRetryResponse(
            "update job status",
            `Invalid status: ${args.status}`,
            jobStatusInstruction
        )
    }
}

export function createAutocodeJobStatusTool(clientOrFileSystem?: OpencodeClient | JobToolFileSystem, fileSystemOrNow?: JobToolFileSystem | (() => Date), maybeNow?: () => Date): ReturnType<typeof tool> {
    const { client, fileSystem, now } = normalizeJobStatusToolArgs(clientOrFileSystem, fileSystemOrNow, maybeNow)
    return tool({
        description: "Update current job status.",
        args: {
            status: tool.schema.string().optional().describe(jobStatusDescription),
        },
        async execute(args, context) {
            const requestedStatusResult = getRequestedStatus(args as Record<string, unknown>)
            if (requestedStatusResult.error) {
                return appendNextAction(requestedStatusResult.error)
            }

            if (!client) {
                return createGenericResponse()
            }

            try {
                const storageRoot = resolveAgentsStorageRoot(context)
                const directoryFileSystem = createDirectoryFileSystem(fileSystem)
                const status = requestedStatusResult.status ?? "executing"
                const identity = await resolvePlannedJobIdentity(directoryFileSystem, client, context, { includeShelved: status === "shelved" })
                if (identity.mode !== "planned" || !identity.job_name || identity.resolution !== "found") {
                    return createGenericResponse()
                }

                const jobName = identity.job_name
                const resolvedJob = identity.resolved_job
                if (!resolvedJob) {
                    return createGenericResponse()
                }
                if (!directoryFileSystem.rename) {
                    return createGenericResponse()
                }
                const moveFileSystem = {
                    ...directoryFileSystem,
                    rename: directoryFileSystem.rename,
                }
                const effectiveStatus = getEffectiveJobStatus(status, resolvedJob.status)
                await updateCurrentSessionTitleToJobName(client, context, jobName, effectiveStatus)

                if (effectiveStatus === "shelved") {
                    const shelved = await shelveResolvedPlannedJob({
                        storageRoot,
                        client: undefined,
                        context,
                        fileSystem,
                        moveFileSystem,
                        now,
                        resolvedJob,
                    })
                    if (shelved.type === "missing") {
                        return createGenericResponse()
                    }
                    if (shelved.type === "collision") {
                        return createGenericResponse()
                    }
                    if (shelved.type === "destination_collision") {
                        return createGenericResponse()
                    }
                    if (!shelved.sandbox_archive.ok) {
                        return createGenericResponse()
                    }

                    return JSON.stringify({
                        next_action: createNextAction(shelved.moved.job.status),
                    })
                }

                const moved = await movePlannedJobToStatus(storageRoot, jobName, effectiveStatus, moveFileSystem)
                if (moved.type === "missing") {
                    return createGenericResponse()
                }
                if (moved.type === "collision") {
                    return createGenericResponse()
                }
                if (moved.type === "destination_collision") {
                    return createGenericResponse()
                }

                return JSON.stringify({
                    next_action: createNextAction(moved.job.status),
                })
            }
            catch {
                return createGenericResponse()
            }
        },
    })
}
