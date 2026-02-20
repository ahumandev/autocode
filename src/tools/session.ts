import { tool, ToolDefinition, PluginInput } from "@opencode-ai/plugin"

type Client = PluginInput["client"]

/**
 * Tools that require the OpenCode client instance.
 * The client is captured at plugin-init time and passed in here via closure.
 */
export function createSessionTools(client: Client): Record<string, ToolDefinition> {

    /**
     * Spawns a new session with a clean context and hands off work to a specific agent.
     * The current session is not affected — the new session starts with no prior history.
     */
    const spawn_session = tool({
        description:
            "Spawn a new opencode session with a clean context and hand off a task to a specific agent. " +
            "Use this when you want to delegate work to another agent without sharing the current conversation history.",
        args: {
            agent: tool.schema
                .string()
                .describe("The agent to hand off to, e.g. 'build', 'solve', 'test', or any custom agent name."),
            message: tool.schema
                .string()
                .describe("The initial message / instructions to send to the new session."),
            title: tool.schema
                .string()
                .optional()
                .describe("Optional title for the new session. Defaults to 'Handoff to <agent>'."),
        },
        async execute(args, _context) {
            // 1. Create a fresh session with no parent — clean context
            const created = await client.session.create({
                body: {
                    title: args.title ?? `Handoff to ${args.agent}`,
                },
                throwOnError: true,
            })

            const sessionId = created.data.id

            // 2. Send the initial message to the target agent and wait for completion
            await client.session.prompt({
                path: { id: sessionId },
                body: {
                    agent: args.agent,
                    parts: [{ type: "text", text: args.message }],
                },
                throwOnError: true,
            })

            return JSON.stringify({
                sessionId,
                agent: args.agent,
                status: "completed",
            })
        },
    })

    return { spawn_session }
}
