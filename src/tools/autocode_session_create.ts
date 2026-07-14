import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { allowedAutocodeSessionCreateAgentsText, createAutocodeSessionCreateSuccessResponse, createAutocodeSessionPrompt, resolveAutocodeAgentSessionSettings, validateAutocodeSessionCreateInput } from "@/utils/agent_swap"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

export function createAutocodeSessionCreateTool(client?: OpencodeClient) {
    return tool({
        description: "Hand off task to new session.",
        args: {
            agent: tool.schema.string().describe(`Agent to execute task.`),
            prompt: tool.schema.string().describe(`Context or instructions to new agent in Caveman English.
             
- Only include summary of info related to task
- But include enough info to prevent unnecessary search work, like: exact files, paths, line numbers, error messages, stack traces
- \`prompt\` outline:
    - GOAL: *what* agent must solve
    - REASON: *why* GOAL matters (1 line max)
    - METRICS: *how* GOAL action is measured or how to summarize response info - what is important (1 bullet point per metric)
    - CONSTRAINTS: *facts* already discovered regarding task (1 bullet point per fact) - avoid redundant re-discovery facts
    - SCOPE: *limits* of subagent actions (1 bullet point per limit) - focus on GOAL, avoid unnecessary work, silence subagent except for useful summarized facts
`),
        },
        async execute(args, context) {
            const validation = validateAutocodeSessionCreateInput(args.prompt, args.agent)
            if ("error" in validation && validation.error === "Missing or invalid prompt") {
                return createRetryResponse(
                    "autocode_session_create",
                    validation.error,
                    validation.instruction
                )
            }

            if ("error" in validation) {
                return createRetryResponse(
                    "autocode_session_create",
                    validation.error,
                    validation.instruction || `Provide agent as one of: ${allowedAutocodeSessionCreateAgentsText}.`
                )
            }

            if (!client) {
                return createAbortResponse("autocode_session_create", "Unable to create fresh session: client is unavailable")
            }

            try {
                const sessionSettings = await resolveAutocodeAgentSessionSettings(validation.agent, context.worktree, context.directory)
                if ("error" in sessionSettings) {
                    return createAbortResponse("autocode_session_create", sessionSettings.error)
                }

                const handoff = await createAutocodeSessionPrompt(
                    client,
                    context.directory,
                    validation.agent,
                    validation.prompt,
                    validation.title,
                    sessionSettings.resolvedModel,
                )
                if ("error" in handoff) {
                    return createAbortResponse("autocode_session_create", handoff.error)
                }

                return createAutocodeSessionCreateSuccessResponse(validation.agent, validation.title, handoff.sessionID)
            }
            catch (error) {
                return createAbortResponse("autocode_session_create", error)
            }
        },
    })
}
