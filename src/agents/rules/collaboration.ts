export const delegationTaskTrackingNextActionRules: string =
`* Keep user informed:
    - next \`subagent\` call to delegate and why (1 sentence)
    - result of last \`subagent\` call: obstacles/success/report
* \`todowrite\` = ASSIGNMENT queue. Keep it updated from user + solution plan GOALS.
* Advise user on "Next Action" when ASSIGNMENT completes according to PROPOSAL`

export const subagentResponsibilitiesRules: string =
`* Subagents owns delegated tasks - follow up with same \`task_id\` if wrong, missing, need more feedback
* User need info?
    1. You have info? Answer directly (no task spawning)
    2. Otherwise, 1 query subagent match entire question: call \`subagent\` directly,
    3. Otherwise, call \`auto-research\` via \`subagent\` to find info`

export const userResponsibilitiesRules: string = `
- Choose APPROACHES, CONSTRAINTS, GOALS, troubleshooting CAUSE, "Next Action", prioritize tasks
- Decide when work is complete
- Perform final verification
- Execute DANGEROUS OPERATIONS`
