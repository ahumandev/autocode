import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { resolveAutocodeAgentSessionSettings, swapCurrentAutocodeSession } from "@/utils/agent_swap"
import { createDirectoryFileSystem, getJobWorkspaceFilePath, isCompatibleJobName, isMissingFile, resolveAgentsStorageRoot, resolveJobWorkspace, type JobToolFileSystem, type JobWorkspaceEntry } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type FileSystem = JobToolFileSystem
type ExecutionAgent = "assist" | "advise" | "auto"

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
    return agent === "assist" || agent === "advise" || agent === "auto"
}

function createAgentExecutePrompt(jobName: string, plan: string): string {
    return `Selected job: ${jobName}\n\nplan:\n${plan}`
}

function createMissingJobRetryResponse(jobName: string): string {
    return createRetryResponse(
        "autocode_agent_execute",
        `Job workspace not found: ${jobName}`,
        "Provide job_name from a timestamped workspace under .agents/jobs/.",
    )
}

function createMissingPlanRetryResponse(jobName: string): string {
    return createRetryResponse(
        "autocode_agent_execute",
        `Design or plan not found for job: ${jobName}`,
        "Restore design.md or plan.md under the selected timestamped job workspace before retrying.",
    )
}

async function readWorkspacePlan(fileSystem: Pick<FileSystem, "readFile">, workspace: JobWorkspaceEntry): Promise<string> {
    try {
        return await fileSystem.readFile(getJobWorkspaceFilePath(workspace, "plan.md"), "utf8")
    }
    catch (error) {
        if (!isMissingFile(error)) throw error
        return fileSystem.readFile(getJobWorkspaceFilePath(workspace, "design.md"), "utf8")
    }
}

export function createAutocodeAgentExecuteTool(client?: OpencodeClient, fileSystem: FileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return tool({
        description: "Swap current session to selected agent with job workspace instructions injected.",
        args: {
            job_name: tool.schema.string().describe("Selected job_name in safe snake_case."),
            agent: tool.schema.string().describe("Execution agent: assist, advise, or auto."),
        },
        async execute(args, context): Promise<string> {
            const requestedJobName = args.job_name?.trim()
            if (!requestedJobName || !isCompatibleJobName(requestedJobName)) {
                return createRetryResponse(
                    "autocode_agent_execute",
                    `Invalid job_name: ${requestedJobName ?? String(args.job_name)}`,
                    "Provide a safe snake_case job_name containing only lowercase letters, numbers, and underscores.",
                )
            }
            if (!isExecutionAgent(args.agent)) {
                return createRetryResponse("autocode_agent_execute", `Invalid agent: ${args.agent}`, "Provide agent as one of: assist, advise, auto.")
            }
            if (!client) {
                return createAbortResponse("autocode_agent_execute", "Unable to swap current session: client is unavailable")
            }

            try {
                const resolved = await resolveJobWorkspace(createDirectoryFileSystem(fileSystem), resolveAgentsStorageRoot(context), requestedJobName)
                if (resolved.type === "missing") {
                    return createMissingJobRetryResponse(requestedJobName)
                }

                let plan: string
                try {
                    plan = await readWorkspacePlan(fileSystem, resolved.workspace)
                }
                catch (error) {
                    if (isMissingFile(error)) return createMissingPlanRetryResponse(requestedJobName)
                    throw error
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
                    createAgentExecutePrompt(resolved.workspace.job_name, plan),
                    sessionSettings.resolvedModel,
                )
                if ("error" in handoff) {
                    return createAbortResponse("autocode_agent_execute", handoff.error)
                }

                return JSON.stringify({ job_name: resolved.workspace.job_name, agent: args.agent })
            }
            catch (error) {
                return createAbortResponse("autocode_agent_execute", error)
            }
        },
    })
}
