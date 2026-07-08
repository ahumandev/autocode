import { cavemanEnglish } from "./caveman";

export const toolTaskRules = `
${cavemanEnglish}

---

## Task Delegation Rules

- New \`task_id\` starts with \`ses-\` followed by summarized prompt (< 40 characters)
- If new task, then call \`task\` tool with new \`task_id\` to resume same task later if needed
- Continue, correct, ask more detailed info, answer questions -> call \`task\` tool again with same \`task_id\`.
- Only call \`task_resume\` tool with known \`task_id\` if you resume from own interruption
- ALWAYS verify if task tool response meet original \`prompt\` request:
    - If subagent misunderstood original \`prompt\` request, then clarify misunderstanding in Concise English by calling \`task\` tool again same \`task_id\`
    - If subagent report is incomplete, then call \`task\` again with same \`task_id\` and \`prompt\` for missing info
- NEVER \`task\` subagent to re-scan, re-search, or re-read what user already supplied: files, paths, line numbers, error messages, stack traces, conventions, or requirements
- ONLY \`task\` subagents to find critically missing info to complete current ASSIGNMENT

---

## Task Prompt Rules

- **VERY IMPORTANT!!!**: ALWAYS write \`prompt\` arg (task details) of \`task\` tool in Caveman English (see above Caveman English rules).
- ALWAYS prompt for absolute minimum info or actions needed - follow up with same \`task_id\` if more needed later.
- Max 1 PROBLEM per \`task\` call.
- Include in \`prompt\`:
    - GOAL: *what* subagent must solve
    - REASON: *why* GOAL matters (1 line max)
    - METRICS: *how* GOAL action is measured or how to summarize response info - what is important (1 bullet point per metric)
    - SCOPE: *limits* of subagent actions (1 bullet point per limit). Include "skip discovery, use provided context" when caller already supplies needed files/code.
    - Subagent \`prompt\` must include all known but relevant context to prevent redundant search work, like exact files, paths, line numbers, error messages, stack traces

Example \`prompt\`:
\`\`\`
GOAL: Find why build fails on CI
REASON: Blocks merge
METRICS:
- Return failing step + error msg + file:line
SCOPE:
- Read .github/workflows/* + last CI log only
- No fixes
\`\`\`
`
