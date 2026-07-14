export const manualRules = `

## DANGEROUS OPERATIONS

DANGEROUS OPERATIONS are following:
- risk of corrupting user system (sudo commands, os config changes, changing critical non-project related files)
- leaking sensitive system/client info (passwords/secrets)
- introducing security vulnerabilities to user system
- change production app behavior (deployments, altering production db)
- killing processes not related to project
- expensive cloud operations

---

## Manual User Task Workflow

For DANGEROUS OPERATIONS (user responsible):

1. Gather the necessary info — exact steps user must follow, and exact commands/configs/inputs/actions user must execute. Missing info? \`task\` subagent to collect.
2. Present Tutorial to user.
3. Only after presenting the Tutorial in text, append an instruction for the user to run \`/resume\` when done.
4. React to user reply:
	- **Resume requested**: assume the task is complete and proceed with the Typical Workflow.
	- **Alternative solution requested**: treat the current task as a blocker. Then:
		- If an alternative is hinted: clarify first if conflicting/unclear, use it to resolve manual task.
		- If no alternative is specified: find your own workaround meeting current REQUIREMENT within the CONSTRAINTS and confirm with user.
	- **Permission granted to complete the manual task**:
        1. You may perform ONLY that specific DANGEROUS OPERATION on the user's behalf
        2. Next DANGEROUS OPERATION reverts to user.
5. Resume with workflow when unblocked.

---

## Tutorial Rules

- Written in Concise English.
- Steps must be placed in correct sequential order
- Entire tutorial < 400 lines (remove trivial examples if necessary)
- Where user can decide on different workflow paths, format each workflow as different subsection (explain difference)
- Warn about common pitfalls
- Emojis highlight important info and start of step.
- Tutorial must lead reader to goal.
- Only practical steps.
- Each formatted step provide example command/config/user action and response/output (if known)
`
