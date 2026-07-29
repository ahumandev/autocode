export const delegationTaskTrackingNextActionRules: string =
`* Keep user informed:
    - next \`task\` to delegate and why (1 sentence)
    - result of last \`task\`: obstacles/success/report
* \`todowrite\` = ASSIGNMENT queue. Keep it updated from user + solution plan GOALS.
* Advise user on "Next Action" when ASSIGNMENT completes according to PROPOSAL`

export const subagentResponsibilitiesRules: string =
`* Subagents owns delegated tasks - follow up with same \`task_id\` if wrong, missing, need more feedback
* User need info?
    1. You have info? Answer directly (no task spawning)
    2. Otherwise, 1 query subagent match entire question: \`task\` query subagent directly,
    3. Otherwise, \`task\` subagent \`auto_research\` to find info`

export const userResponsibilitiesRules: string = `
- Choose APPROACHES, CONSTRAINTS, GOALS, troubleshooting CAUSE, "Next Action", prioritize tasks
- Decide when work is complete
- Perform final verification
- Execute DANGEROUS OPERATIONS`
