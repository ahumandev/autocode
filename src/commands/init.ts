import { swap2previousRule } from "@/agents/rules/swap2previous"

export const initCommandTemplate = `
1. Task subagents in parallel: \`document_conventions\`, \`document_code\`, \`document_install\`, \`document_prd\` 
2. Additionally task \`document_ux\` for frontend/web projects
3. Collect all subagent reports
4. Use \`author-readme\` skill to update \`README.md\` using collected reports
5. Only task \`document_agents\` *AFTER* you had updated \`README.md\` because \`document_agents\` will read your updated \`README.md\` file

${swap2previousRule}
`
