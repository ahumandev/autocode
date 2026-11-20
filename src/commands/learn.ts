import type { Config } from "@opencode-ai/sdk/v2"

type CommandMap = NonNullable<Config["command"]>

export const learnCommand = {
    description: "🧠 Learn from recent discussion.",
    subtask: false,
    template: `
1. If <user-guidance> block is empty: Gather corrections, research results, overall feature design decisions, user requirements, project insights.
   - Else gather relevant facts according to below <user-guidance> block
   - Honor explicit remember requests
   - Exclude secrets, credentials, and transient progress.
2. Ask \`learn-memory\` subagent with existing \`sessionID\` if known and related. Prompt include all gathered facts and links to sources (if known).

<user-guidance>
$ARGUMENTS
</user-guidance>
`,
} satisfies CommandMap[string]
