import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { createAutocodeSession, dispatchAutocodeAgentPromptAfterTurn, resolveAutocodeAgentSessionSettings } from "@/utils/agent_swap"
import { createDirectoryFileSystem, formatJobWorkspaceTitle, getJobWorkspaceFilePath, isMissingFile, listJobWorkspaces, resolveAgentsStorageRoot, resolveJobWorkspaceIdentity, type JobToolFileSystem, type JobWorkspaceEntry } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type FileSystem = JobToolFileSystem
type ExecutionAgent = "auto" | "assist"

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

function isExecutionAgent(agent: string): agent is ExecutionAgent {
    return agent === "auto" || agent === "assist"
}

function createAgentExecutePrompt(jobName: string, plan: string): string {
    return `Selected job: ${jobName}\n\nUse this plan as job instructions. Start first actionable unblocked step. Ask user when decision needed. Do safe work. Do not assume later plan context.\n\nplan:\n${plan}`
}

function createMissingWorkspaceFileRetryResponse(jobName: string): string {
    return createRetryResponse(
        "autocode_job_execute",
        `Job workspace is missing design.md or plan.md: ${jobName}`,
        "Restore design.md or plan.md in the timestamped job workspace before retrying execution.",
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

async function persistJobSessionID(fileSystem: Pick<FileSystem, "writeFile">, workspace: JobWorkspaceEntry, sessionID: string): Promise<void> {
    await fileSystem.writeFile(getJobWorkspaceFilePath(workspace, "session.yml"), `session_id: ${sessionID}\n`)
}

export function createAutocodeJobExecuteTool(client?: OpencodeClient, fileSystem: FileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return tool({
        description: "Start job in new session.",
        args: {
            agent: tool.schema.string().describe("Agent to run: auto or assist."),
        },
        async execute(args, context): Promise<string> {
            try {
                if (!isExecutionAgent(args.agent)) {
                    return createRetryResponse("autocode_job_execute", `Invalid agent: ${args.agent}`, "Provide agent as one of: auto, assist.")
                }
                if (!client) {
                    return createAbortResponse("autocode_job_execute", "Unable to create execution session: client is unavailable")
                }

                const storageRoot = resolveAgentsStorageRoot(context)
                const directoryFileSystem = createDirectoryFileSystem(fileSystem)
                const identity = await resolveJobWorkspaceIdentity(directoryFileSystem, client, context)
                if (identity.workspace !== undefined) {
                    let plan: string
                    try {
                        plan = await readWorkspacePlan(fileSystem, identity.workspace)
                    }
                    catch (error) {
                        if (isMissingFile(error)) return createMissingWorkspaceFileRetryResponse(identity.workspace.job_name)
                        throw error
                    }

                    const sessionSettings = await resolveAutocodeAgentSessionSettings(args.agent, context.worktree, context.directory)
                    if ("error" in sessionSettings) {
                        return createAbortResponse("autocode_job_execute", sessionSettings.error)
                    }

                    const sessionTitle = formatJobWorkspaceTitle(identity.workspace.job_name)
                    const createdSession = await createAutocodeSession(client, context.directory, sessionTitle, args.agent)
                    if ("error" in createdSession) {
                        return createAbortResponse("autocode_job_execute", createdSession.error)
                    }

                    await persistJobSessionID(fileSystem, identity.workspace, createdSession.sessionID)
                    dispatchAutocodeAgentPromptAfterTurn(
                        client,
                        context.directory,
                        createdSession.sessionID,
                        args.agent,
                        createAgentExecutePrompt(identity.workspace.job_name, plan),
                        sessionSettings.resolvedModel,
                    )

                    return JSON.stringify({
                        result_type: "session_created",
                        job_name: identity.workspace.job_name,
                        session_id: createdSession.sessionID,
                        session_title: sessionTitle,
                        message: `Created new session for ${args.agent}: ${sessionTitle} (${createdSession.sessionID}).`,
                    })
                }

                const listed = await listJobWorkspaces(directoryFileSystem, storageRoot)
                if (listed.jobs.length === 0) {
                    return JSON.stringify({ result_type: "no_workspaces" })
                }

                return JSON.stringify({
                    result_type: "workspace_required",
                    warning: identity.warning,
                })
            }
            catch (error) {
                return createAbortResponse("autocode_job_execute", error)
            }
        },
    })
}
