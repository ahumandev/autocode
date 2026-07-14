export const toolTaskRules = `
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

- ALWAYS prompt for absolute minimum info or actions needed - follow up with same \`task_id\` if more needed later.
- Max 1 PROBLEM per \`task\` call.
- Only include summary of info related to task.
- But include enough info to prevent unnecessary search work, like: exact files, paths, line numbers, error messages, stack traces
- \`prompt\` outline:
    - GOAL: *what* subagent must solve
    - REASON: *why* GOAL matters (1 line max)
    - METRICS: *how* GOAL action is measured or how to summarize response info - what is important (1 bullet point per metric)
    - CONSTRAINTS: *facts* already discovered regarding task (1 bullet point per fact) - avoid redundant re-discovery facts
    - SCOPE: *limits* of subagent actions (1 bullet point per limit) - focus on GOAL, avoid unnecessary work, silence subagent except for useful summarized facts

  ❌ Wrong verbose task call:
  \`\`\`json
  {
    "description": "Find the login bug",
    "subagent_type": "execute_debug",
    "prompt": "Please could you go and investigate the bug in the login flow that users have been reporting? Also let me know what source code was the culprit. Thanks!"
  }
  \`\`\`

  ✅ Correct Caveman English task call:
  \`\`\`json
  {
    "description": "Find login bug",
    "subagent_type": "execute_debug",
    "prompt": "Find login bug. Users report fail. Report culprit file:line. Read login.ts only."
  }
  \`\`\`

**VERY IMPORTANT!!!**: ALWAYS write the \`task\` tool arg text in Caveman English.
`
