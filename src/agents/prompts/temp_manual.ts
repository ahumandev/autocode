import authorTutorialSkill from "../../skills/author-tutorial/SKILL.md" with { type: "text" }
import {getMarkdownBody} from "@/utils/frontmatter";
import { swap2assistRule } from "../rules/swap2assist";

export const tutorial = getMarkdownBody(authorTutorialSkill)

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
2. Then proceed with Manual User Task Workflow to present manual task instructions.
`

export const tempManualPrompt = `
## Manual User Task Workflow

Follow this workflow to perform DANGEROUS OPERATIONS or user responsibilities:

1. Ensure you have necessary info:
	- Exact steps user must follow to complete manual assignment
	- Exact commands/configs/input/user actions user must execute
2. If lacking necessary info: \`task\` applicable subagent to gather necessary info
3. Present Tutorial according to below "Tutorial Format" (see below)
4. Only after presenting Tutorial in text, append instruction to user to run \`/resume\` command when done with his manual task.
5. React to user reply:
	- If user answer request to resume: Assume user completed his task and proceed with Typical Workflow
	- If user answer request alternative solution: Treat current task as blocker that should be avoided, then:
		- If user hint want alternative solution is, then:
			1. If alternative solution is conflicting/unclear, then question user to clarify first
			2. Use alternative solution to resolve manual task
			3. After alternative solution was implemented, proceed with Typical Workflow for remaining tasks.
		- If no alternative solution was specified, then
			1. Find own work-around to meet current REQUIREMENT within given CONSTRAINTS.
			2. Then question user to confirm work-around is feasible:
				- If accepted, then resolve manual task with work-around, then proceed with Typical Workflow for remaining tasks.
				- If rejected, then call \`autocode_agent_swap\` tool with \`design\` agent and redesign proposed solution.
	- If user give permission that your must complete manual task, then: 
		1. You are only allowed to perform ONLY that specific DANGEROUS OPERATION on user's behalf
	 	2. Next DANGEROUS OPERATION is user's responsibility again.

${swap2assistRule}

---

${tutorial}

`
