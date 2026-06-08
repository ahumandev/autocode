// Shared instruction fragment: always include task_id when calling the built-in `task` tool
export const toolTaskRules = `
## Task Delegation Rules
- **Call \`task\` tool** to delegate tasks to subagents
- **Caveman English** - Write Caveman English in \`prompt\`
- **Provide context** - Give subagent background (< 40 words): Why its task is required
- **Expectation** - What feedback/info is expected
- **Research Scope** - How much, how precise and where to look for info (if applicable)
- **Recovery** - How to recover from previous mistake (if re-prompting same session)

- New \`task_id\` starts with \`ses-\` followed by summarized prompt (< 40 characters)
- If new task, then call \`task\` tool with new \`task_id\` to resume same task later if needed
- Continue, correct, or answer questions for the same work by calling \`task\` tool again with same \`task_id\`.
- Only call \`task_resume\` tool with known \`task_id\` if you resume from own interruption
- ALWAYS verify if task tool response meet original \`prompt\` request:
    - If subagent misunderstood original \`prompt\` request: Clarify misunderstanding in Concise English and call \`task\` again with same \`task_id\`
    - If subagent report is incomplete: call \`task\` again with same \`task_id\` and \`prompt\` for missing info
`
