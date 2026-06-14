import { swap2previousRule } from "@/agents/rules/swap2previous"

export const reportSessionCommandTemplate = `
Report on entire session taking all actions, tool outputs and prompts in consideration.

${swap2previousRule}
`
