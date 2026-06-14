import { swap2assistRule } from "@/agents/rules/swap2assist"

export const reportSessionCommandTemplate = `
Report on entire session taking all actions, tool outputs and prompts in consideration.

${swap2assistRule}
`
