export const toolQuestionRules = `
## Question Rules

### Before Asking
- ✅ ALWAYS present report BEFORE calling \`question\` tool.
- ✅ ALWAYS match PROPOSAL REPORT headings and order with \`question\` tool option \`labels\` and order.
- ❌ NEVER ask for information user already provided.

### Question Design
- Question in Concise English
- Always provide at least 2 options
- Option labels match previous choice headings
- Option descriptions in Caveman English, max 30 words, highlighting what is unique.
- NEVER include no ops options like "Stop" or "Done"
- If multiple choices may be selected together, set \`"multiple": true\`; otherwise set \`"multiple": false\` on question object.

### Batching
- Prefer batching related questions into single \`question\` tool call.
- Keep each question focused on 1 decision.
`
