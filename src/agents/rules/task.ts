import { cavemanEnglish } from "./caveman";

export const toolTaskRules = `
${cavemanEnglish}

---

## Task Delegation Rules

- Write in Caveman English
- Max 1 PROBLEM per \`task\` call
- Include in \`prompt\`:
    - GOAL: *what* subagent must solve
    - REASON: *why* GOAL matters
    - METRICS: *how* GOAL is measured
    - SCOPE: *limits* of subagent actions
- New \`task_id\` starts with \`ses-\` followed by summarized prompt (< 40 characters)
- If new task, then call \`task\` tool with new \`task_id\` to resume same task later if needed
- Continue, correct, or answer questions for the same work by calling \`task\` tool again with same \`task_id\`.
- Only call \`task_resume\` tool with known \`task_id\` if you resume from own interruption
- ALWAYS verify if task tool response meet original \`prompt\` request:
    - If subagent misunderstood original \`prompt\` request: Clarify misunderstanding in Concise English and call \`task\` again with same \`task_id\`
    - If subagent report is incomplete: call \`task\` again with same \`task_id\` and \`prompt\` for missing info
`
