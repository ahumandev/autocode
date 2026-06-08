import type { OpencodeClient } from "@opencode-ai/sdk"
import { getAgentTier } from "@/agents"
import type { ModelTier, TierConfig } from "@/config"
import { loadAutocodeConfig } from "@/config"
import { flattenError } from "@/utils/tools"

export const allowedAutocodeSessionCreateAgents = ["assist", "auto", "research", "design"] as const
export const allowedAutocodeSessionCreateAgentsText = allowedAutocodeSessionCreateAgents.join(", ")

export type AutocodeSessionCreateAgent = typeof allowedAutocodeSessionCreateAgents[number]

type ValidatedAutocodeSessionCreateInput = {
    prompt: string
    agent: AutocodeSessionCreateAgent
    title: string
}

type ValidatedAutocodeAgentSwapInput = {
    prompt: string
    agent: string
    title: string
}

type InvalidAutocodeAgentSwapInput = {
    error: string
    instruction: string
}

type AutocodeAgentSessionPromptResult = {
    sessionID: string
}

type AutocodeAgentPromptDispatchResult = {
    sessionID: string
}

type ResolvedAgentModel = {
    model?: {
        providerID: string
        modelID: string
    }
    variant?: string
}

type ResolvedAutocodeAgentSessionSettings = {
    resolvedModel: ResolvedAgentModel
}

type OpenCodeApiResponse<T> = {
    data?: T
    error?: unknown
}

type OpenCodeApiResponseOrData<T> = OpenCodeApiResponse<T> | T

export type AutocodeSessionClient = Pick<OpencodeClient, "session">

type AutocodeSessionApi = {
    session: {
        create: OpencodeClient["session"]["create"]
        update: OpencodeClient["session"]["update"]
        promptAsync: OpencodeClient["session"]["promptAsync"]
    }
}

type SessionPromptAsyncBody = {
    agent: string
    model?: ResolvedAgentModel["model"]
    parts: Array<{ type: "text", text: string }>
}

function isNonBlankString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0
}

function createAutocodeSessionError(stage: string, directory: string, sessionOrTitle: string, agent: string, error: unknown): string {
    return `Autocode session API failed (stage=${stage}, directory=${directory}, session/title=${sessionOrTitle}, agent=${agent}): ${flattenError(error)}`
}

function unwrapOpenCodeData<T>(response: OpenCodeApiResponseOrData<T>): T | undefined {
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

function resolveAutocodeAgentSessionTier(agent: string): ModelTier | undefined {
    return getAgentTier(agent)
}

export function resolveTierModel(tier: ModelTier | undefined, tiers: Partial<Record<ModelTier, TierConfig>>): ResolvedAgentModel {
    if (!tier) {
        return {}
    }

    const configuredModel = tiers[tier]?.model?.trim()
    if (!configuredModel) {
        return {}
    }

    const slashIndex = configuredModel.indexOf("/")
    if (slashIndex <= 0 || slashIndex === configuredModel.length - 1) {
        return {}
    }

    const providerID = configuredModel.slice(0, slashIndex).trim()
    const modelID = configuredModel.slice(slashIndex + 1).trim()
    if (!providerID || !modelID) {
        return {}
    }

    return {
        model: { providerID, modelID },
        variant: tiers[tier]?.variant === "standard" ? undefined : tiers[tier]?.variant,
    }
}

export function deriveAutocodeAgentSwapTitle(prompt: string): string {
    return prompt.slice(0, 60)
}

export function validateAutocodeAgentSwapInput(
    rawPrompt: unknown,
    rawAgent: unknown,
): ValidatedAutocodeAgentSwapInput | InvalidAutocodeAgentSwapInput {
    if (!isNonBlankString(rawPrompt)) {
        return {
            error: "Missing or invalid prompt",
            instruction: "Provide a nonblank string prompt.",
        }
    }

    if (!isNonBlankString(rawAgent)) {
        return {
            error: `Invalid agent: ${typeof rawAgent === "string" ? rawAgent : String(rawAgent)}`,
            instruction: "Provide a non-blank agent name.",
        }
    }

    const prompt = rawPrompt.trim()
    const agent = rawAgent.trim()

    return {
        prompt,
        agent,
        title: deriveAutocodeAgentSwapTitle(prompt),
    }
}

export function validateAutocodeSessionCreateInput(
    rawPrompt: unknown,
    rawAgent: unknown,
): ValidatedAutocodeSessionCreateInput | InvalidAutocodeAgentSwapInput {
    if (!isNonBlankString(rawPrompt)) {
        return {
            error: "Missing or invalid prompt",
            instruction: `Provide a nonblank string prompt and select one of these agents: ${allowedAutocodeSessionCreateAgentsText}.`,
        }
    }

    if (!isNonBlankString(rawAgent) || !allowedAutocodeSessionCreateAgents.includes(rawAgent.trim() as AutocodeSessionCreateAgent)) {
        return {
            error: `Invalid agent: ${typeof rawAgent === "string" ? rawAgent : String(rawAgent)}`,
            instruction: `Provide agent as one of: ${allowedAutocodeSessionCreateAgentsText}.`,
        }
    }

    const prompt = rawPrompt.trim()
    const agent = rawAgent.trim() as AutocodeSessionCreateAgent

    return {
        prompt,
        agent,
        title: deriveAutocodeAgentSwapTitle(prompt),
    }
}

export async function dispatchAutocodeAgentPrompt(
    client: AutocodeSessionApi,
    directory: string,
    sessionID: string,
    agent: string,
    prompt: string,
    resolvedModel: ResolvedAgentModel = {}
): Promise<AutocodeAgentPromptDispatchResult | InvalidAutocodeAgentSwapInput> {
    try {
        const body: SessionPromptAsyncBody = {
            agent,
            parts: [{ type: "text", text: prompt }],
        }
        if (resolvedModel.model) {
            body.model = resolvedModel.model
        }

        const promptResponse = await client.session.promptAsync({
            path: { id: sessionID },
            query: { directory },
            body,
        })
        const promptError = unwrapOpenCodeError(promptResponse)
        if (promptError) {
            return { error: createAutocodeSessionError("prompt_dispatch", directory, sessionID, agent, promptError), instruction: "" }
        }
    }
    catch (error) {
        return { error: createAutocodeSessionError("prompt_dispatch", directory, sessionID, agent, error), instruction: "" }
    }

    return { sessionID }
}

export async function resolveAutocodeAgentSessionSettings(
    agent: string,
    worktree: string,
    directory: string,
): Promise<ResolvedAutocodeAgentSessionSettings | InvalidAutocodeAgentSwapInput> {
    const tier = resolveAutocodeAgentSessionTier(agent)
    const { tiers } = await loadAutocodeConfig(worktree, directory)

    return {
        resolvedModel: resolveTierModel(tier, tiers),
    }
}

export async function createAutocodeSession(
    client: AutocodeSessionApi,
    directory: string,
    title: string,
    agent: string,
): Promise<AutocodeAgentSessionPromptResult | InvalidAutocodeAgentSwapInput> {
    let sessionData: { id: string } | undefined
    try {
        const sessionResponse = await client.session.create({
            query: { directory },
            body: { title },
        })
        const sessionError = unwrapOpenCodeError(sessionResponse)
        sessionData = unwrapOpenCodeData(sessionResponse) as { id: string } | undefined
        if (sessionError || !sessionData) {
            return { error: createAutocodeSessionError("session_create", directory, title, agent, sessionError ?? "Unable to create fresh session"), instruction: "" }
        }
    }
    catch (error) {
        return { error: createAutocodeSessionError("session_create", directory, title, agent, error), instruction: "" }
    }

    return { sessionID: sessionData.id }
}

export async function createAutocodeSessionPrompt(
    client: AutocodeSessionApi,
    directory: string,
    agent: string,
    prompt: string,
    title: string,
    resolvedModel: ResolvedAgentModel = {}
): Promise<AutocodeAgentSessionPromptResult | InvalidAutocodeAgentSwapInput> {
    const sessionResult = await createAutocodeSession(client, directory, title, agent)
    if ("error" in sessionResult) {
        return sessionResult
    }

    const promptResult = await dispatchAutocodeAgentPrompt(client, directory, sessionResult.sessionID, agent, prompt, resolvedModel)
    if ("error" in promptResult) {
        return promptResult
    }

    return sessionResult
}

export function createAutocodeSessionCreateSuccessResponse(agent: string, title: string, sessionID: string): string {
    const message = `Created new session for ${agent}: ${title} (${sessionID}).`

    return JSON.stringify({
        session_id: sessionID,
        agent,
        session_title: title,
        session_action: "created",
        message,
    })
}

export function createAutocodeAgentSwapSuccessResponse(agent: string, sessionID: string): string {
    const message = `Swapped current session to ${agent} (${sessionID}).`

    return JSON.stringify({
        session_id: sessionID,
        agent,
        session_action: "swapped",
        message,
    })
}

export async function swapCurrentAutocodeSession(
    client: AutocodeSessionApi,
    directory: string,
    sessionID: string,
    agent: string,
    prompt: string,
    resolvedModel: ResolvedAgentModel = {},
): Promise<AutocodeAgentSessionPromptResult | InvalidAutocodeAgentSwapInput> {
    return dispatchAutocodeAgentPrompt(client, directory, sessionID, agent, prompt, resolvedModel)
}
