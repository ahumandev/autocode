import type { Config } from "@opencode-ai/sdk/v2"
import type { PlatformCapabilities } from "../utils/platform"

type CommandMap = NonNullable<Config["command"]>

export function createInstallCommand(capabilities: PlatformCapabilities): CommandMap[string] {
    return capabilities.isWindows ? windowsInstallCommand : linuxInstallCommand
}

const linuxInstallCommand = {
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
8. After remediation, rerun \`autocode_dependencies\` and report remaining issues.
9. Summarize succeeded, failed, skipped, unsupported, manual-action, and still missing dependencies.
10. After summary report, perform no next action, just stop.
`
} satisfies CommandMap[string]

const windowsInstallCommand = {
    agent: "assist",
    description: "Install or remediate Autocode runtime dependencies.",
    subtask: false,
    template: `
1. Call \`autocode_dependencies\` first.
2. Only treat as no issues when \`next_actions\` is empty, \`required_ok\` is not false, and every optional dependency is ok/skipped/unsupported or has no manual action; then report dependencies OK and stop.
3. Do not stop just because top-level \`ok\` is true. Remediate every dependency as optional when safe; continue after failures and do not let one failure stop the rest.
4. If OpenCode upgrade is needed, use the suggested \`opencode upgrade\` command in CMD.
5. Handle OpenCode (opencode), chrome-devtools MCP (chrome_devtools_mcp), Context7 MCP (context7_mcp), Excel MCP (excel_mcp), Git CLI (git_cli), and browser availability using reported \`install_command\`/guidance. Run commands in CMD and prefer reported \`install_command\`/guidance.
6. Follow dangerous-operation/manual confirmation rules: password prompts, API keys, manual confirmation, and destructive operations must stop/ask/report, not force.
7. After remediation, rerun \`autocode_dependencies\` and report remaining issues.
8. Summarize succeeded, failed, skipped, unsupported, manual-action, and still missing dependencies.
9. After summary report, perform no next action, just stop.
`
} satisfies CommandMap[string]
