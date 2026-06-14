export function buildJobExecutionCommandTemplate(agent: "assist" | "auto"): string {
    return `
Call \`autocode_job_execute\` with \`agent\` = \`${agent}\`, then evaluate tool output:
    - \`result_type == "draft_required"\`, then restart your Design Workflow without tasking other agents and draft a solution plan to execute.
    - \`result_type == "no_plans"\`, then tell user there are no plans to execute and that he should run \`/job-draft\` command first to create a drafted solution plan in \`.agents/jobs/drafts/{name}/plan.md\`.
    - \`result_type == "session_created"\`, then respond with:

\`\`\`markdown
Follow job at new session called: "[session_title]".
\`\`\`

Replace [session_title] with \`session_title\` value from \`autocode_job_execute\` tool response.
`
}
