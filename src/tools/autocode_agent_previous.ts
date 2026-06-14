import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createAutocodeAgentPreviousSkippedResponse, createAutocodeAgentSwapSuccessResponse, findPreviousPrimaryAutocodeAgent, resolveAutocodeAgentSessionSettings, swapCurrentAutocodeSession } from "@/utils/agent_swap"
import { createAbortResponse } from "@/utils/tools"

export function createAutocodeAgentPreviousTool(client?: OpencodeClient): ReturnType<typeof tool> {
    return tool({
        description: "Swap agent back to previous primary agent.",
        args: {},
        async execute(_args, context) {
            if (!client) {
                return createAbortResponse("autocode_agent_previous", "Unable to inspect current session history: client is unavailable")
            }

            try {
                const currentAgent = (context as { agent?: string }).agent
                const previousPrimary = await findPreviousPrimaryAutocodeAgent(client, context.directory, context.sessionID, currentAgent)
                if ("error" in previousPrimary) {
                    return createAbortResponse("autocode_agent_previous", previousPrimary.error)
                }
                if (previousPrimary.skipped || !previousPrimary.agent) {
                    return createAutocodeAgentPreviousSkippedResponse(
                        context.sessionID,
                        previousPrimary.reason ?? "No previous primary agent found in current session history."
                    )
                }

                const sessionSettings = await resolveAutocodeAgentSessionSettings(previousPrimary.agent, context.worktree, context.directory)
                if ("error" in sessionSettings) {
                    return createAbortResponse("autocode_agent_previous", sessionSettings.error)
                }

                const handoff = await swapCurrentAutocodeSession(
                    client,
                    context.directory,
                    context.sessionID,
                    previousPrimary.agent,
                    "Ask user for Next Action.",
                    sessionSettings.resolvedModel
                )
                if ("error" in handoff) {
                    return createAbortResponse("autocode_agent_previous", handoff.error)
                }

                return createAutocodeAgentSwapSuccessResponse(previousPrimary.agent, handoff.sessionID)
            }
            catch (error) {
                return createAbortResponse("autocode_agent_previous", error)
            }
        },
    })
}
