export const taskPrompt = `
* **VERY IMPORTANT!!!**: ALWAYS write \`prompt\` in Caveman English.
* New session has no context - ONLY this \`prompt\`.
* Distill for clean context:
    - INCLUDE only task-relevant facts: exact files, paths, line numbers, urls, error messages, stack traces, versions, config values.
    - OMIT noise: irrelevant ideas, raw tool/query outputs, irrelevant ideas, full file contents, unrelated findings.
    - Frame as actionable INSTRUCTIONS, not a passive report.
* \`prompt\` includes:
    - GOAL: *what* subagent must solve (1 line)
    - REASON: *why* GOAL matters (1 line)
    - CONTRAINTS: *facts* already discovered regarding task (list)
    - SCOPE: *limits* of subagent actions to avoid unnecessary work (list)
`

export const toolTaskRules = `
## Task Delegation Rules

* New \`task_id\` starts with \`ses-\` followed by summarized prompt (< 40 characters)
* If new task, then call \`task\` tool with new \`task_id\` to resume same task later if needed
* Continue, correct, ask more detailed info, answer questions -> call \`task\` tool again with same \`task_id\`.
* Only call \`task_resume\` tool with known \`task_id\` if you resume from own interruption
* ALWAYS verify if task tool response meet original \`prompt\` request:
    - If subagent misunderstood original \`prompt\` request, then clarify misunderstanding in Concise English by calling \`task\` tool again same \`task_id\`
    - If subagent report is incomplete, then call \`task\` again with same \`task_id\` and \`prompt\` for missing info
* NEVER \`task\` subagent to re-scan, re-search, or re-read what user already supplied: files, paths, line numbers, error messages, stack traces, conventions, or requirements
* ONLY \`task\` subagents to find critically missing info to complete current ASSIGNMENT

---

## Task Prompt Rules

* ALWAYS prompt for absolute minimum info or actions needed - follow up with same \`task_id\` if more needed later.
* Max 1 PROBLEM per \`task\` call.
${taskPrompt}
    - METRICS: how success is measured from subagent / important info needed from subagent
* NEVER \`prompt\` for full content / output, instead \`prompt\` for answers: snippets, outlines, pseudo code, steps, summaries -> let subagent do work.
`
