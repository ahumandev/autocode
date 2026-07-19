import type { Config } from "@opencode-ai/sdk/v2"

type CommandMap = NonNullable<Config["command"]>

export const learnCommand = {
    description: "Learn from recent discussion (corrections, env, permissions, preferences).",
    subtask: false,
    template: `
1. If current session is insufficient to identify lessons, stop.
2. Identify lessons worth persisting across sessions. For each lesson, categorize it into EXACTLY ONE of:
   - **correction** (mistake that was corrected) → call \`skill_learn_correction\`
   - **env** (dev environment fact or limitation discovered) → call \`skill_learn_env\` (pass \`ssh_key\` if it concerns a remote host)
   - **permission** (manual task confirmed safe, or a warning about a dangerous task) → call \`skill_learn_permission\`
   - **preference** (reviewer/user preference discovered, typically after a complaint or correction) → call \`skill_learn_preference\`
3. For EACH identified lesson, call matching \`skill_learn_*\` tool.
4. Skip categories that have no lessons. Do NOT force \`skill_learn_*\` calls.
5. Avoid duplicates: No repeating of existing skills in skill list. Session may contain previous skill_learn tool calls. No repeating of same info to learn.
6. See <user-guidance> block below. If not empty: target that topic to learn from session.
7. Do NOT create/edit any project files. Only call \`skill_learn_*\` tools if needed.

<user-guidance>
$ARGUMENTS
</user-guidance>
`,
} satisfies CommandMap[string]
