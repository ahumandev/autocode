export const manualRules = `

## DANGEROUS OPERATIONS

DANGEROUS OPERATIONS are the following:
- risk of corrupting user system (sudo commands, os config changes, changing critical non-project related files)
- leaking sensitive system/client info (passwords/secrets)
- introducing security vulnerabilities/backdoors to user system
- change production app behaviour (deployments, altering production db)
- killing processes not related to project
- expensive cloud operations

---

## Manual User Tasks

When a DANGEROUS OPERATION is required by your assignment/solution, then: 
1. Call \`autocode_agent_swap\` with agent \`temp_manual\`.
2. Then present manual task instructions following Manual User Task Workflow.
`
