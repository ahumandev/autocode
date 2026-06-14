import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises"
import { resolveAutocodeAgentSessionSettings, swapCurrentAutocodeSession } from "@/utils/agent_swap"
import { createDirectoryFileSystem, getJobFilePath, isCompatibleJobName, moveResolvedPlannedJobToStatus, resolveAgentsStorageRoot, resolvePlannedJob, type JobStatus, type JobToolFileSystem, type StartJobFileSystem } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type FileSystem = JobToolFileSystem

type ExecutionAgent = "assist" | "auto"

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

function isExecutionAgent(agent: unknown): agent is ExecutionAgent {
    return agent === "assist" || agent === "auto"
}

function getTargetStatus(agent: ExecutionAgent, _currentStatus: JobStatus): JobStatus {
    return agent === "assist" ? "assist" : "executing"
}

function createAgentExecutePrompt(jobName: string, plan: string): string {
    return `Selected job: ${jobName}\n\nplan.md:\n${plan}`
}

function createMissingJobRetryResponse(jobName: string): string {
    return createRetryResponse(
        "autocode_agent_execute",
        `Planned job not found: ${jobName}`,
        "Provide job_name from an existing lifecycle job under .agents/jobs/."
    )
}

function createCollisionRetryResponse(jobName: string): string {
    return createRetryResponse(
        "autocode_agent_execute",
        `Active lifecycle collision for ${jobName}`,
        "Resolve duplicate active lifecycle directories for this job before retrying."
    )
}

function createDestinationCollisionRetryResponse(jobName: string, status: JobStatus): string {
    return createRetryResponse(
        "autocode_agent_execute",
        `${status} lifecycle directory already exists for ${jobName}`,
        `Resolve the existing .agents/jobs/${status}/ job collision before retrying.`
    )
}

function createMissingPlanRetryResponse(jobName: string): string {
    return createRetryResponse(
        "autocode_agent_execute",
        `Plan not found for job: ${jobName}`,
        "Restore plan.md under the selected job lifecycle directory before retrying."
    )
}

function createReviewStatusRetryResponse(jobName: string): string {
    return createRetryResponse(
        "autocode_agent_execute",
        `Selected job already in review: ${jobName}`,
        "Select job outside review before retrying autocode_agent_execute."
    )
}

export function createAutocodeAgentExecuteTool(client?: OpencodeClient, fileSystem: FileSystem = defaultFileSystem) {
    return tool({
        description: "Move selected job to execution status and swap current session to selected agent with plan.md injected.",
        args: {
            job_name: tool.schema.string().describe("Selected planned job_name in safe snake_case."),
            agent: tool.schema.string().describe("Execution agent: assist or auto."),
        },
        async execute(args, context) {
            const requestedJobName = args.job_name?.trim()
            if (!requestedJobName || !isCompatibleJobName(requestedJobName)) {
                return createRetryResponse(
                    "autocode_agent_execute",
                    `Invalid job_name: ${requestedJobName ?? String(args.job_name)}`,
                    "Provide a safe snake_case job_name containing only lowercase letters, numbers, and underscores."
                )
            }

            if (!isExecutionAgent(args.agent)) {
                return createRetryResponse("autocode_agent_execute", `Invalid agent: ${args.agent}`, "Provide agent as one of: assist, auto.")
            }

            if (!client) {
                return createAbortResponse("autocode_agent_execute", "Unable to swap current session: client is unavailable")
            }

            try {
                const storageRoot = resolveAgentsStorageRoot(context)
                const directoryFileSystem = createDirectoryFileSystem(fileSystem)
                const resolved = await resolvePlannedJob(directoryFileSystem, storageRoot, requestedJobName)

                if (resolved.type === "missing") {
                    return createMissingJobRetryResponse(requestedJobName)
                }

                if (resolved.type === "collision") {
                    return createCollisionRetryResponse(requestedJobName)
                }

                if (resolved.job.status === "review") {
                    return createReviewStatusRetryResponse(requestedJobName)
                }

                const planPath = getJobFilePath(storageRoot, resolved.job.directory, resolved.job.job_name, "plan.md")
                let plan: string
                try {
                    plan = await fileSystem.readFile(planPath, "utf8")
                }
                catch (error) {
                    const code = (error as NodeJS.ErrnoException).code
                    if (code === "ENOENT") {
                        return createMissingPlanRetryResponse(requestedJobName)
                    }

                    throw error
                }

                if (!directoryFileSystem.rename) {
                    return createAbortResponse("autocode_agent_execute", "Unable to update selected job lifecycle: rename is unavailable")
                }

                const targetStatus = getTargetStatus(args.agent, resolved.job.status)
                const moveFileSystem: StartJobFileSystem = {
                    ...directoryFileSystem,
                    rename: directoryFileSystem.rename,
                }
                const moved = await moveResolvedPlannedJobToStatus(storageRoot, resolved.job, targetStatus, moveFileSystem)
                if (moved.type === "missing") {
                    return createMissingJobRetryResponse(requestedJobName)
                }

                if (moved.type === "collision") {
                    return createCollisionRetryResponse(requestedJobName)
                }

                if (moved.type === "destination_collision") {
                    return createDestinationCollisionRetryResponse(requestedJobName, targetStatus)
                }

                const sessionSettings = await resolveAutocodeAgentSessionSettings(args.agent, context.worktree, context.directory)
                if ("error" in sessionSettings) {
                    return createAbortResponse("autocode_agent_execute", sessionSettings.error)
                }

                const handoff = await swapCurrentAutocodeSession(
                    client,
                    context.directory,
                    context.sessionID,
                    args.agent,
                    createAgentExecutePrompt(moved.job.job_name, plan),
                    sessionSettings.resolvedModel
                )
                if ("error" in handoff) {
                    return createAbortResponse("autocode_agent_execute", handoff.error)
                }

                return JSON.stringify({
                    current_status: moved.job.status,
                })
            }
            catch (error) {
                return createAbortResponse("autocode_agent_execute", error)
            }
        },
    })
}
