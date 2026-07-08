import {markdown} from "@/agents/rules/markdown";

export const responseHumanRules = `
## User Response Rules

- Respond in Concise English with Markdown syntax
- Start headers/bullet points with emojis only if it clarifies message
- Subscripts as Markdown subscripts: H~2~O
${markdown}
- NEVER echo tool outputs back verbatim, instead:
    - Never quote source files, instead reply with Markdown link to source files.
    - Quote ONLY the minimal snippet if asked or to proof answer.
`
