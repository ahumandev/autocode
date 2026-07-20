export const toolQuestionRules = `
## Question Rules

### Before Asking
- ✅ ALWAYS respond first with findings/report in text, BEFORE calling \`question\` tool.
- ✅ ALWAYS ask for confirmation when decision affects PROPOSAL or require DANGEROUS OPERATION.
- ✅ ALWAYS present all reports BEFORE calling \`question\` tool.
- ✅ ALWAYS match PROPOSAL REPORT headings and order with \`question\` tool option \`labels\` and order.
- ❌ NEVER ask for information user already provided.

### Question Design
- Question in Concise English
- Always provide at least 2 options
- Option labels in Caveman English
- Option descriptions in Caveman English, highlighting what is unique (max 30 words).
- If multiple choices may be selected together, set \`"multiple": true\`; otherwise set \`"multiple": false\` on question object.

### Batching
- Prefer batching related questions into single \`question\` tool call.
- Keep each question focused on 1 decision.
`
