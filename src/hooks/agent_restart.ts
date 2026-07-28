import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk"
import { readFile, readdir } from "node:fs/promises"
import { createAgentRestartPrompt } from "@/hooks/agent_restart_prompt"
import { createDirectoryFileSystem, getJobFilePath, isMissingFile, resolveAgentsStorageRoot, resolvePlannedJobIdentity, type JobToolFileSystem } from "@/utils/jobs"
import {
    dispatchAutocodeAgentPrompt,
    isPrimaryAutocodeAgent,
    resolveAutocodeAgentSessionSettings,
    type PrimaryAutocodeAgent,
    type ResolvedAgentModel,
} from "@/utils/agent_swap"
import { createAbortResponse, createRetryResponse, flattenError } from "@/utils/tools"

type SessionMessage = {
    info: Message
    parts: Part[]
}

export type AgentRestartCompactionResponse = {
    data?: boolean
    error?: unknown
}

type OpenCodeApiResponse<T> = {
    data?: T
    error?: unknown
}

type SessionMessagesMethod = NonNullable<OpencodeClient["session"]["messages"]>
type SessionMessagesResponse = Awaited<ReturnType<SessionMessagesMethod>>

type SessionMessagesClient = Pick<OpencodeClient, "session"> & {
    session: {
        messages?: SessionMessagesMethod
    }
}

type SessionSummarizeRequest = {
    path: { id: string }
    query: { directory: string }
    body: {
        providerID: string
        modelID: string
        auto: false
    }
}

export type AgentRestartContext = {
    sessionID: string
    directory: string
    worktree: string
}

export type AgentRestartInput = {
    client: OpencodeClient
    context: AgentRestartContext
    targetAgent: unknown
}

export type ActiveAutocodeAgentResult =
    | { currentAgent: PrimaryAutocodeAgent }
    | { error: string }

export type AgentRestartDependencies = {
    findActiveAutocodeAgent?: typeof findActiveAutocodeAgent
    resolveAutocodeAgentSessionSettings?: typeof resolveAutocodeAgentSessionSettings
    summarizeAutocodeAgentSession?: typeof summarizeAutocodeAgentSession
    dispatchAutocodeAgentPrompt?: typeof dispatchAutocodeAgentPrompt
    readCurrentJobPlan?: typeof readCurrentJobPlan
}

export type CurrentJobPlan = {
    jobName: string
    plan: string
}

async function readDirectory(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | import("fs").Dirent[]> {
    return options?.withFileTypes ? readdir(dirPath, { withFileTypes: true }) : readdir(dirPath)
}

const defaultJobFileSystem: Pick<JobToolFileSystem, "readFile" | "readdir"> = {
    readFile,
    readdir: readDirectory,
}

function unwrapOpenCodeData<T>(response: OpenCodeApiResponse<T> | T): T | undefined {
    if (response && typeof response === "object" && "data" in response) {
        return (response as OpenCodeApiResponse<T>).data
    }

    return response as T
}

function unwrapOpenCodeError(response: unknown): unknown {
    if (response && typeof response === "object" && "error" in response) {
        return (response as OpenCodeApiResponse<unknown>).error
    }

    return undefined
}

function getMessageCreatedTime(message: SessionMessage): number {
    return message.info.time.created
}

function hasResolvedModel(model: ResolvedAgentModel): model is ResolvedAgentModel & { model: { providerID: string; modelID: string } } {
    return typeof model.model?.providerID === "string"
        && model.model.providerID.trim().length > 0
        && typeof model.model.modelID === "string"
        && model.model.modelID.trim().length > 0
}

export async function findActiveAutocodeAgent(
    client: SessionMessagesClient,
    directory: string,
    sessionID: string,
): Promise<ActiveAutocodeAgentResult> {
    if (!client.session.messages) {
        return { error: "Unable to inspect current session history: session.messages is unavailable" }
    }

    let response: SessionMessagesResponse
    try {
        response = await client.session.messages({
            path: { id: sessionID },
            query: { directory, limit: 200 },
        })
    }
    catch (error) {
        return { error: `Unable to inspect current session history: ${flattenError(error)}` }
    }

    const responseError = unwrapOpenCodeError(response)
    if (responseError !== undefined) {
        return { error: `Unable to inspect current session history: ${flattenError(responseError)}` }
    }

    const messages = unwrapOpenCodeData<SessionMessage[]>(response) ?? []
    const currentMessage = [...messages]
        .sort((left, right) => getMessageCreatedTime(right) - getMessageCreatedTime(left))
        .find((message) => message.info.role === "user")
    if (!currentMessage) {
        return { error: "Unable to identify current agent from newest session user message." }
    }
    const currentAgent = (currentMessage.info as Message & { agent?: unknown }).agent
    if (!isPrimaryAutocodeAgent(currentAgent)) {
        return { error: "Unsupported current agent in newest session user message." }
    }

    return { currentAgent }
}

export async function summarizeAutocodeAgentSession(
    client: OpencodeClient,
    directory: string,
    sessionID: string,
    model: { providerID: string; modelID: string },
): Promise<AgentRestartCompactionResponse> {
    const summarize = client.session.summarize as unknown as (request: SessionSummarizeRequest) => Promise<AgentRestartCompactionResponse>
    return summarize({
        path: { id: sessionID },
        query: { directory },
        body: { ...model, auto: false },
    })
}

export async function readCurrentJobPlan(
    client: OpencodeClient,
    context: AgentRestartContext,
    fileSystem: Pick<JobToolFileSystem, "readFile" | "readdir"> = defaultJobFileSystem,
): Promise<CurrentJobPlan | undefined> {
    const directoryFileSystem = createDirectoryFileSystem(fileSystem)
    const identity = await resolvePlannedJobIdentity(directoryFileSystem, client, context)
    const job = identity.resolved_job
    if (!job) return undefined

    try {
        const plan = await fileSystem.readFile(getJobFilePath(resolveAgentsStorageRoot(context), job.directory, job.job_name, "plan.md"), "utf8")
        return { jobName: job.job_name, plan }
    }
    catch (error) {
        if (isMissingFile(error)) return undefined
        throw error
    }
}

export async function restartAutocodeAgentInSession(
    input: AgentRestartInput,
    deps: AgentRestartDependencies = {},
): Promise<string> {
    if (!isPrimaryAutocodeAgent(input.targetAgent)) {
        return createAbortResponse("validation", `Invalid target agent: ${String(input.targetAgent)}`, "Provide target agent as one of: assist, teach, auto, research, design.")
    }

    const targetAgent = input.targetAgent
    const resolveSettings = deps.resolveAutocodeAgentSessionSettings ?? resolveAutocodeAgentSessionSettings
    let settings: Awaited<ReturnType<typeof resolveAutocodeAgentSessionSettings>>
    try {
        settings = await resolveSettings(targetAgent, input.context.worktree, input.context.directory)
    }
    catch (error) {
        return createAbortResponse("configuration resolution", error)
    }
    if (!settings || typeof settings !== "object") {
        return createAbortResponse("configuration resolution", "Target agent settings are unavailable.")
    }
    if ("error" in settings) {
        return createAbortResponse("configuration resolution", settings.error)
    }
    if (!hasResolvedModel(settings.resolvedModel)) {
        return createAbortResponse("configuration resolution", "Resolved target agent model is unavailable or invalid.")
    }

    const findActiveAgent = deps.findActiveAutocodeAgent ?? findActiveAutocodeAgent
    let activeAgent: ActiveAutocodeAgentResult
    try {
        activeAgent = await findActiveAgent(input.client, input.context.directory, input.context.sessionID)
    }
    catch (error) {
        return createAbortResponse("validation", `Unable to inspect current session history: ${flattenError(error)}`)
    }
    if ("error" in activeAgent) {
        return createAbortResponse("validation", activeAgent.error)
    }

    const summarize = deps.summarizeAutocodeAgentSession ?? summarizeAutocodeAgentSession
    let compaction: AgentRestartCompactionResponse
    try {
        compaction = await summarize(input.client, input.context.directory, input.context.sessionID, settings.resolvedModel.model)
    }
    catch (error) {
        return createRetryResponse("compaction", error, "Retry same-session compaction before continuation dispatch.")
    }
    if (compaction.error !== undefined || compaction.data !== true) {
        return createRetryResponse("compaction", compaction.error ?? "Session compaction did not complete.", "Retry same-session compaction before continuation dispatch.")
    }

    let jobPlan: CurrentJobPlan | undefined
    if (targetAgent === "assist" || targetAgent === "auto") {
        const readPlan = deps.readCurrentJobPlan ?? readCurrentJobPlan
        try {
            jobPlan = await readPlan(input.client, input.context)
        }
        catch (error) {
            return createRetryResponse("current job plan lookup", error, "Retry restart after current job plan lookup succeeds.")
        }
    }

    const dispatch = deps.dispatchAutocodeAgentPrompt ?? dispatchAutocodeAgentPrompt
    const prompt = createAgentRestartPrompt({ currentAgent: activeAgent.currentAgent, targetAgent, jobPlan })
    let dispatched: Awaited<ReturnType<typeof dispatchAutocodeAgentPrompt>>
    try {
        dispatched = await dispatch(input.client, input.context.directory, input.context.sessionID, targetAgent, prompt, settings.resolvedModel)
    }
    catch (error) {
        return createRetryResponse("continuation dispatch", `Compaction completed, but continuation dispatch failed: ${flattenError(error)}`, "Retry continuation dispatch in this same session; compaction completed.")
    }
    if ("error" in dispatched) {
        return createRetryResponse("continuation dispatch", `Compaction completed, but continuation dispatch failed: ${dispatched.error}`, "Retry continuation dispatch in this same session; compaction completed.")
    }

    return JSON.stringify({
        session_id: input.context.sessionID,
        current_agent: activeAgent.currentAgent,
        target_agent: targetAgent,
        compaction_completed: true,
        continuation_dispatched: true,
    })
}
