import type { Config } from "@opencode-ai/sdk/v2"

type CommandMap = NonNullable<Config["command"]>

export const learnCommand = {
    description: "🧠 Remember durable lesson from recent discussion.",
    subtask: false,
    template: `
1. If current session has no durable lesson, stop.
2. See <user-guidance> block below. If not empty, target that topic.
3. Call \`learn\` exactly once with durable lesson.
4. Do not store secrets or temporary task progress.
5. Do NOT create or edit project files.

<user-guidance>
$ARGUMENTS
</user-guidance>
`,
} satisfies CommandMap[string]
