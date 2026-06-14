export const jobExecuteCommandTemplate = `
1. Call \`autocode_job_list\` to list all available jobs.
2. Call \`question\` once with exactly two batched questions:
    - Choose one available job from \`autocode_job_list\` output.
    - Choose execution agent: \`auto\` or \`assist\`.
3. Call \`autocode_agent_execute\` once with selected \`job_name\` and selected \`agent\`, then evaluate tool output:
    - If output includes \`failedAction\`, follow returned \`instruction\` exactly and stop.
    - If output includes \`current_status\`, respond to user:

\`\`\`markdown
Continue job in [agent] session.
\`\`\`

Replace [agent] with selected execution agent.
`
