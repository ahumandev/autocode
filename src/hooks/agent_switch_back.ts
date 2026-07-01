import type { Event, OpencodeClient } from "@opencode-ai/sdk"
import {
    findPreviousPrimaryAutocodeAgent,
    isPrimaryAutocodeAgent,
    resolveAutocodeAgentSessionSettings,
    swapCurrentAutocodeSession,
} from "@/utils/agent_swap"

const TEMP_AGENT_PREFIX = "temp_"
const SWAP_BACK_PROMPT = "Present the next action to the user using the question tool."

type AgentSwitchBackDeps = {
    findPreviousPrimaryAutocodeAgent?: typeof findPreviousPrimaryAutocodeAgent
    resolveAutocodeAgentSessionSettings?: typeof resolveAutocodeAgentSessionSettings
    swapCurrentAutocodeSession?: typeof swapCurrentAutocodeSession
}

export function createAgentSwitchBackHook(
    client: OpencodeClient,
    directory: string,
    worktree: string,
    deps: AgentSwitchBackDeps = {},
): (input: { event: Event }) => Promise<void> {
    const findPrevFn = deps.findPreviousPrimaryAutocodeAgent ?? findPreviousPrimaryAutocodeAgent
    const resolveSettingsFn = deps.resolveAutocodeAgentSessionSettings ?? resolveAutocodeAgentSessionSettings
    const swapFn = deps.swapCurrentAutocodeSession ?? swapCurrentAutocodeSession

    const currentAgentBySession = new Map<string, string>()
    const lastPrimaryBySession = new Map<string, string>()

    return async (input: { event: Event }): Promise<void> => {
        try {
            const event = input.event

            if (event.type === "message.updated") {
                const info = (event as { properties: { info: { sessionID?: unknown; agent?: unknown } } }).properties.info
                const sessionID = info.sessionID
                const agent = info.agent
                if (typeof sessionID !== "string" || sessionID.trim().length === 0) return
                if (typeof agent !== "string" || agent.trim().length === 0) return
                currentAgentBySession.set(sessionID, agent)
                if (isPrimaryAutocodeAgent(agent)) {
                    lastPrimaryBySession.set(sessionID, agent)
                }
                return
            }

            if (event.type === "session.idle") {
                const sessionID = (event as { properties: { sessionID?: unknown } }).properties.sessionID
                if (typeof sessionID !== "string" || sessionID.trim().length === 0) return

                const current = currentAgentBySession.get(sessionID)
                if (!current) return
                if (isPrimaryAutocodeAgent(current)) return
                if (!current.startsWith(TEMP_AGENT_PREFIX)) return

                let target = lastPrimaryBySession.get(sessionID)
                if (!target) {
                    const fallback = await findPrevFn(client, directory, sessionID, current)
                    if ("error" in fallback) return
                    if (fallback.skipped || !fallback.agent) return
                    target = fallback.agent
                }

                const settings = await resolveSettingsFn(target, worktree, directory)
                if ("error" in settings) return

                const result = await swapFn(client, directory, sessionID, target, SWAP_BACK_PROMPT, settings.resolvedModel)
                if (!("error" in result)) {
                    currentAgentBySession.set(sessionID, target)
                }
                return
            }

            if (event.type === "session.deleted") {
                const properties = (event as { properties: { info?: { id?: unknown; sessionID?: unknown }; sessionID?: unknown } }).properties
                const sessionID = properties.info?.id ?? properties.sessionID ?? properties.info?.sessionID
                if (typeof sessionID === "string") {
                    currentAgentBySession.delete(sessionID)
                    lastPrimaryBySession.delete(sessionID)
                }
            }
        }
        catch {
            // A hook MUST NEVER throw — swallow all errors.
        }
    }
}
