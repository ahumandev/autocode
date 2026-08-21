export function jobExecutionCommandTemplate(agent: "assist" | "advise" | "auto"): string {
    return `
Call \`autocode_job_execute\` with \`agent\` = \`${agent}\`, then evaluate tool output:
    - If output includes \`failedAction\`, follow returned \`instruction\` exactly and stop.
    - \`result_type == "workspace_required"\`, then tell user current session does not match an available job workspace and stop.
    - \`result_type == "no_workspaces"\`, then tell user there are no job workspaces to execute and stop.
    - \`result_type == "session_created"\`, then respond with:
`
}
