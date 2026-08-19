import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { createAutocodeSession, dispatchAutocodeAgentPromptAfterTurn, resolveAutocodeAgentSessionSettings } from "@/utils/agent_swap"
import { createDirectoryFileSystem, formatJobSessionTitle, getJobFilePath, listPlannedJobs, moveResolvedPlannedJobToStatus, resolveAgentsStorageRoot, resolvePlannedJobIdentity, resolvePlannedJob, selectableExecutionJobStatuses, type JobStatus, type JobToolFileSystem, type StartJobFileSystem } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type FileSystem = JobToolFileSystem

const executionAgentStatuses = {
    assist: "facilitate",
    advise: "facilitate",
    auto: "executing",
} as const satisfies Record<"auto" | "assist" | "advise", JobStatus>

async function readDirectory(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | import("fs").Dirent[]> {
    return options?.withFileTypes ? readdir(dirPath, { withFileTypes: true }) : readdir(dirPath)
}

const defaultFileSystem: FileSystem = {
    mkdir,
    readFile,
    readdir: readDirectory,
    rename,
    rm,
    stat,
    writeFile,
}

function createStartRetryResponse(result: { type: "missing" } | { type: "collision" } | { type: "destination_collision" }, jobName: string, status: JobStatus): string {
    if (result.type === "missing") {
        return createRetryResponse(
            "autocode_job_execute",
            `Planned job not found: ${jobName}`,
            "Select a job from the active lifecycle directories under .agents/jobs/ before executing."
        )
    }

    if (result.type === "collision") {
        return createRetryResponse(
            "autocode_job_execute",
            `Active lifecycle collision for ${jobName}`,
            "Resolve duplicate active lifecycle directories for this job before retrying."
        )
    }

    return createRetryResponse(
        "autocode_job_execute",
        `${status} lifecycle directory already exists for ${jobName}`,
        `Resolve the existing .agents/jobs/${status}/ job collision before retrying.`
    )
}

function createMissingResolvedJobFileRetryResponse(jobName: string): string {
    return createRetryResponse(
        "autocode_job_execute",
        `Resolved planned job is missing a required file: ${jobName}`,
        "Restore the planned job plan.md file under .agents/jobs/ before retrying execution."
    )
}

function isExecutionAgent(agent: string): agent is "auto" | "assist" | "advise" {
    return agent === "auto" || agent === "assist" || agent === "advise"
}

function createAgentExecutePrompt(jobName: string, plan: string): string {
    return `Selected job: ${jobName}\n\nUse this plan as job instructions. Start first actionable unblocked step. Ask user when decision needed. Do safe work. Do not assume later plan context.\n\nplan.md:\n${plan}`
}

async function persistJobSessionID(fileSystem: Pick<FileSystem, "writeFile">, worktree: string, job: { directory: JobStatus }, jobName: string, sessionID: string): Promise<void> {
    await fileSystem.writeFile(getJobFilePath(worktree, job.directory, jobName, "session.yml"), `session_id: ${sessionID}\n`)
}

export function createAutocodeJobExecuteTool(client?: OpencodeClient, fileSystem: FileSystem = defaultFileSystem) {
    return tool({
        description: "Execute job.",
        args: {
            agent: tool.schema.string().describe("Agent to run: auto, assist, or advise."),
        },
        async execute(args, context) {
            try {
                if (!isExecutionAgent(args.agent)) {
                    return createRetryResponse("autocode_job_execute", `Invalid agent: ${args.agent}`, "Provide agent as one of: auto, assist, advise.")
                }

                const storageRoot = resolveAgentsStorageRoot(context)
                const directoryFileSystem = createDirectoryFileSystem(fileSystem)
                const identity = await resolvePlannedJobIdentity(directoryFileSystem, client, context)
                const resolvedJobName = identity.job_name

                if (resolvedJobName) {
                    const resolved = await resolvePlannedJob(directoryFileSystem, storageRoot, resolvedJobName, { ignoreCollisions: true })

                    if (resolved.type === "found") {
                        try {
                            if (!client) {
                                return createAbortResponse("autocode_job_execute", "Unable to continue execution session: client is unavailable")
                            }

                            const planPath = getJobFilePath(storageRoot, resolved.job.directory, resolvedJobName, "plan.md")
                            const plan = await fileSystem.readFile(planPath, "utf8")

                            const startStatus = executionAgentStatuses[args.agent]
                            const sessionTitle = formatJobSessionTitle(resolvedJobName, startStatus)
                            const sessionSettings = await resolveAutocodeAgentSessionSettings(args.agent, context.worktree, context.directory)
                            if ("error" in sessionSettings) {
                                return createAbortResponse("autocode_job_execute", sessionSettings.error)
                            }

                            if (!directoryFileSystem.rename) {
                                return createAbortResponse("autocode_job_execute", "Unable to start planned job execution: rename is unavailable")
                            }

                            const createdSession = await createAutocodeSession(client, context.directory, sessionTitle, args.agent)
                            if ("error" in createdSession) {
                                return createAbortResponse("autocode_job_execute", createdSession.error)
                            }

                            const startFileSystem: StartJobFileSystem = {
                                ...directoryFileSystem,
                                rename: directoryFileSystem.rename,
                            }
                            const startResult = await moveResolvedPlannedJobToStatus(storageRoot, resolved.job, startStatus, startFileSystem)
                            if (startResult.type !== "success") {
                                return createStartRetryResponse(startResult, resolvedJobName, startStatus)
                            }

                            const { job } = startResult
                            await persistJobSessionID(fileSystem, storageRoot, job, resolvedJobName, createdSession.sessionID)

                            dispatchAutocodeAgentPromptAfterTurn(
                                client,
                                context.directory,
                                createdSession.sessionID,
                                args.agent,
                                createAgentExecutePrompt(resolvedJobName, plan),
                                sessionSettings.resolvedModel,
                            )

                            return JSON.stringify({
                                result_type: "session_created",
                                job_name: resolvedJobName,
                                session_id: createdSession.sessionID,
                                session_title: sessionTitle,
                                message: `Created new session for ${args.agent}: ${sessionTitle} (${createdSession.sessionID}).`,
                            })
                        }
                        catch (error) {
                            const code = (error as NodeJS.ErrnoException).code
                            if (code !== "ENOENT") {
                                throw error
                            }

                            return createMissingResolvedJobFileRetryResponse(resolvedJobName)
                        }
                    }
                }

                const listed = await listPlannedJobs(fileSystem, storageRoot)
                const jobs = listed.jobs.filter((job) => (selectableExecutionJobStatuses as readonly JobStatus[]).includes(job.status))
                if (jobs.length === 0) {
                    return JSON.stringify({
                        result_type: "no_plans",
                    })
                }

                if (identity.job_name) {
                    return JSON.stringify({
                        result_type: "draft_required",
                        job_name: identity.job_name,
                        warning: identity.warning,
                    })
                }

                return JSON.stringify({
                    result_type: "draft_required",
                    warning: identity.warning,
                })
            }
            catch (error) {
                return createAbortResponse("autocode_job_execute", error)
            }
        },
    })
}
