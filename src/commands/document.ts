import { swap2assistRule } from "@/agents/rules/swap2assist"

export const documentCommandTemplate = `
1. Determine responsible subagents to document recent project changes: \`document_conventions\`, \`document_code\`, \`document_install\`, \`document_prd\`, \`document_ux\`
2. Task responsible subagent with instruction to update their SKILL.md file with only relevant changes (include only related changes in prompt - must match subagent description).
3. Collect subagent reports
4. Update \`README.md\` using collected reports (only update applicable sections - not entire file)
5. Only task \`document_agents\` *AFTER* you had updated \`README.md\` with prompt to check if any of recent changes are applicable to content in AGENTS.md (only update AGENTS.md if outdated)

${swap2assistRule}
`
