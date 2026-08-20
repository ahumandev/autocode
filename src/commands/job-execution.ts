export function jobExecutionCommandTemplate(agent: "assist" | "advise" | "auto"): string {
    return `
Call \`autocode_job_execute\` with \`agent\` = \`${agent}\`, then evaluate tool output:
    - If output includes \`failedAction\`, follow returned \`instruction\` exactly and stop.
    - \`result_type == "workspace_required"\`, then restart your Design Workflow without tasking other agents and save a solution design to execute.
    - \`result_type == "no_workspaces"\`, then tell user there are no job workspaces to execute and that they should run \`/job-draft\` first to create \`.agents/jobs/{timestamp}_{name}/design.md\`.
    - \`result_type == "session_created"\`, then respond with:
`
}
