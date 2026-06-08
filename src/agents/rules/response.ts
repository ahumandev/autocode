import {markdown} from "@/agents/rules/markdown";

export const responseRules = `
## User Response Rules

- Respond in Concise English with Markdown syntax
- Start headers/bullet points with emojis only if it clarifies message
- Subscripts as Markdown subscripts: H~2~O
${markdown}
`
