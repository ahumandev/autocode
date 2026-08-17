import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { restartAutocodeAgentInSession } from "@/hooks/agent_restart"
import type { PendingAgentRestartCoordinator } from "@/hooks/agent_restart_coordinator"
import { primaryAutocodeAgents } from "@/utils/agent_swap"
import { createAbortResponse } from "@/utils/tools"

export function createAutocodeSessionRestartTool(client?: OpencodeClient, coordinator?: PendingAgentRestartCoordinator): ReturnType<typeof tool> {
    return tool({
        description: "Restart a primary agent in this same session.",
        args: {
            agent: tool.schema.enum(primaryAutocodeAgents).describe("Agent to continue in this session."),
        },
        async execute(args, context): Promise<string> {
            if (!client) {
                return createAbortResponse("autocode_session_restart", "Unable to restart current session: client is unavailable")
            }
            if (!coordinator) {
                return createAbortResponse("autocode_session_restart", "Unable to restart current session: restart lifecycle is unavailable")
            }

            return restartAutocodeAgentInSession({
                client,
                context: {
                    sessionID: context.sessionID,
                    directory: context.directory,
                    worktree: context.worktree,
                },
                targetAgent: args.agent,
                abort: context.abort,
                coordinator,
            })
        },
    })
}
