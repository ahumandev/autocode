export const planCommandTemplate = `
Summarize the current plan/status from available conversation context and $ARGUMENTS.

If no plan exists, say no current plan was found.

Then call \`autocode_agent_swap\` with agent exactly \`design\` and prompt to suggestion how plan could be revised using \`question\` tool.
`
