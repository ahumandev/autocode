import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createAutocodeAgentSwapSuccessResponse, resolveAutocodeAgentSessionSettings, swapCurrentAutocodeSession, validateAutocodeAgentSwapInput } from "@/utils/agent_swap"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

export function createAutocodeAgentSwapTool(client?: OpencodeClient) {
    return tool({
        description: "Swap agent in this session.",
        args: {
            agent: tool.schema.string().describe("Name of agent to swap to."),
            prompt: tool.schema.string().describe("Instructions to agent."),
        },
        async execute(args, context) {
            const validation = validateAutocodeAgentSwapInput(args.prompt, args.agent)
            if ("error" in validation) {
                return createRetryResponse(
                    "autocode_agent_swap",
                    validation.error,
                    validation.instruction || "Provide a non-blank agent name."
                )
            }

            if (!client) {
                return createAbortResponse("autocode_agent_swap", "Unable to swap current session: client is unavailable")
            }

            try {
                const sessionSettings = await resolveAutocodeAgentSessionSettings(validation.agent, context.worktree, context.directory)
                if ("error" in sessionSettings) {
                    return createAbortResponse("autocode_agent_swap", sessionSettings.error)
                }

                const handoff = await swapCurrentAutocodeSession(
                    client,
                    context.directory,
                    context.sessionID,
                    validation.agent,
                    validation.prompt,
                    sessionSettings.resolvedModel
                )
                if ("error" in handoff) {
                    return createAbortResponse("autocode_agent_swap", handoff.error)
                }

                return createAutocodeAgentSwapSuccessResponse(validation.agent, handoff.sessionID)
            }
            catch (error) {
                return createAbortResponse("autocode_agent_swap", error)
            }
        },
    })
}
