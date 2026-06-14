import { swap2assistRule } from "@/agents/rules/swap2assist"

export const reportLastCommandTemplate = `
Report **ONLY** on your last assignment (last user requested task). Include only last user prompt, recent actions since last user prompt and recent tool outputs into consideration when you compile the report.

${swap2assistRule}
`
