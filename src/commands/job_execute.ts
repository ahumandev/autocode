export const jobExecuteCommandTemplate = `
1. Call \`autocode_job_list\` to list all available jobs.
2. Call \`question\` once with exactly two batched questions:
    - Choose one available job from \`autocode_job_list\` output.
    - Choose execution agent: \`auto\` or \`assist\`.
3. Call \`autocode_plan_read\` with selected \`job_name\` to read the selected job plan.
4. Call \`autocode_agent_swap\` with \`agent\` set to the selected agent.
`
