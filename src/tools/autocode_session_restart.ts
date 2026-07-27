import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { restartAutocodeAgentInSession } from "@/hooks/agent_restart"
import { primaryAutocodeAgents } from "@/utils/agent_swap"
import { createAbortResponse } from "@/utils/tools"

export function createAutocodeSessionRestartTool(client?: OpencodeClient): ReturnType<typeof tool> {
    return tool({
        description: "Restart a primary agent in this same session.",
        args: {
            agent: tool.schema.enum(primaryAutocodeAgents).describe("Agent to continue in this session."),
        },
        async execute(args, context) {
            if (!client) {
                return createAbortResponse("autocode_session_restart", "Unable to restart current session: client is unavailable")
            }

            return restartAutocodeAgentInSession({
                client,
                context: {
                    sessionID: context.sessionID,
                    directory: context.directory,
                    worktree: context.worktree,
                },
                targetAgent: args.agent,
            })
        },
    })
}
