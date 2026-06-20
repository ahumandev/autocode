import type { Config } from "@opencode-ai/sdk/v2"

type CommandMap = NonNullable<Config["command"]>

export const installCommand = {
    agent: "assist",
    description: "Install or remediate Autocode runtime dependencies.",
    subtask: false,
    template: `
1. Call \`autocode_dependencies\` first.
2. Only treat as no issues when \`next_actions\` is empty, \`required_ok\` is not false, and every optional dependency is ok/skipped/unsupported or has no manual action; then report dependencies OK and stop.
3. Do not stop just because top-level \`ok\` is true. Remediate every dependency as optional when safe; continue after failures and do not let one failure stop the rest.
4. If OpenCode upgrade is needed, use the suggested \`opencode upgrade\` command.
5. If bwrap install is needed, use the reported install command.
6. Handle chrome-devtools MCP (chrome_devtools_mcp), Context7 MCP (context7_mcp), Excel MCP (excel_mcp) availability using reported install_command/guidance; if git_cli is missing, remediate system Git CLI using reported install_command/guidance.
7. Follow dangerous-operation/manual confirmation rules: sudo, password prompts, API keys, manual confirmation, and destructive operations must stop/ask/report, not force.
8. Do not perform documentation tasks
9. do not task any \`document_*\` subagents
10. After remediation, rerun \`autocode_dependencies\` and report remaining issues.
11. Summarize succeeded, failed, skipped, unsupported, manual-action, and still missing dependencies.
12. After summary report, perform no next action, just stop.
`
} satisfies CommandMap[string]
