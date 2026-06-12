import { swap2assistRule } from "@/agents/rules/swap2assist"
import type { Config } from "@opencode-ai/sdk/v2"

/**
 * Command definitions for the Autocode plugin.
 *
 * Commands are registered programmatically via the `config` hook so they are
 * self-contained in the npm package — no Markdown files need to be copied or
 * referenced from the filesystem by the end user.
 *
 * Each entry matches the Config.Command schema:
 *   { template, description?, agent?, model?, subtask? }
 *
 * The `.opencode/command/` files in this repo are the LOCAL DEV equivalent —
 * opencode loads them from disk when running from the project root.
 * When deployed as a npm package, only this file is used.
 */

type CommandMap = NonNullable<Config["command"]>

function buildJobExecutionTemplate(agent: "assist" | "auto"): string {
    return `
Call \`autocode_job_execute\` with \`agent\` = \`${agent}\`, then evaluate tool output:
    - \`result_type == "draft_required"\`, then restart your Design Workflow without tasking other agents and draft a solution plan to execute.
    - \`result_type == "no_plans"\`, then tell user there are no plans to execute and that he should run \`/job-draft\` command first to create a drafted solution plan in \`.agents/jobs/drafts/{name}/plan.md\`.
    - \`result_type == "session_created"\`, then respond with:

\`\`\`markdown
Follow job at new session called: "[session_title]".
\`\`\`

Replace [session_title] with \`session_title\` value from \`autocode_job_execute\` tool response.
`
}

function buildNewSessionTemplate(agent: string, promptInstructions: string, responsePrefix: string): string {
    return `
$ARGUMENTS

__________

1. Call \`autocode_session_create\` with \`agent\` = \`${agent}\` and \`prompt\` ${promptInstructions}
2. Respond to user:

\`\`\`markdown
${responsePrefix}: "[session_title]".
\`\`\`

Replace [session_title] with \`session_title\` value from \`autocode_session_create\` tool response.
`
}

const installCommand = {
    agent: "assist",
    description: "Install or remediate Autocode runtime dependencies.",
    subtask: false,
    template: `
1. Call \`autocode_dependencies\` first.
2. Only treat as no issues when \`next_actions\` is empty, \`required_ok\` is not false, and every optional dependency is ok/skipped/unsupported or has no manual action; then report dependencies OK and stop.
3. Do not stop just because top-level \`ok\` is true. Remediate every dependency as optional when safe; continue after failures and do not let one failure stop the rest.
4. If OpenCode upgrade is needed, use the suggested \`opencode upgrade\` command.
5. If bwrap install is needed, use the reported install command.
6. Handle chrome-devtools MCP (chrome_devtools_mcp), Context7 MCP (context7_mcp), Excel MCP (excel_mcp), Git MCP (git_mcp), and browser (browser) availability using reported install_command/guidance.
7. Follow dangerous-operation/manual confirmation rules: sudo, password prompts, API keys, manual confirmation, and destructive operations must stop/ask/report, not force.
8. Do not perform documentation tasks
9. do not task any \`document_*\` subagents
10. After remediation, rerun \`autocode_dependencies\` and report remaining issues.
11. Summarize succeeded, failed, skipped, unsupported, manual-action, and still missing dependencies.
12. After summary report, perform no next action, just stop.
`
} satisfies CommandMap[string]

export const commands: CommandMap = {

    // Job lifecycle commands

    "job-concepts": {
        agent: "temp_concept",
        description: "Save concepts in .agents/jobs/concepts/.",
        subtask: false,
        template: "$ARGUMENTS"
    },

    "job-design": {
        agent: "design",
        description: "Design a solution plan from a concept in .agents/jobs/concepts/",
        subtask: false,
        template: `$ARGUMENTS        

_____________________________

If you recently created a concept with \`autocode_concept_create\`, then use that concept's content as your INSTRUCTIONS, otherwise:

1. Call \`autocode_concept_list\` tool to list available concepts.
2. If no items were listed, reply to user: "No concepts found in \`.agents/jobs/concepts\`. Describe the project improvement I should design." and wait for user requirements.
3. If concepts were listed, display available concept labels using \`question\` tool and ask "Which concept should we use to design an implementation plan?"
4. Call \`autocode_concept_read\` with the selected concept \`label\` to read your INSTRUCTIONS.
5. Continue implementation-proposal planning in the current session using the returned concept context and recent conversation.
`
    },

    "job-draft": {
        agent: "design",
        description: "Save drafted solution plan in .agents/jobs/drafts/{name}/plan.md",
        subtask: false,
        template: `
1. Call \`autocode_plan_save\` tool with planned sections: PROBLEMS, REQUIREMENTS, CONSTRAINTS, RISKS, and user chosen PROPOSAL.
2. Respond with:

\`\`\`markdown
Your plan is saved at: \`[job_path]\`

Enter:
- \`/job-execute-assist\` 👨‍💻 to execute the planned job assistively
- \`/job-execute-auto\`   🤖 to execute the planned job autonomously
\`\`\`

Replace [job_path] with \`job_path\` value from \`autocode_plan_save\` tool response.

# Plan Formatting Rules

- Never include H1, H2, or \`---\` separators in tool input.
- Requirements, constraints, and risks should use H3 subsections.
- Keep user examples and quoted evidence intact.
- Use emojis only to highlight important points.
- Include markdown links to sources consulted.
- Every constraints must be backed by evidence, assumptions are risks.
`,
    },

    "job-execute-assist": {
        agent: "design",
        description: "Assist with job execution in new session. Job will move to .agents/jobs/assist/{name}/.",
        subtask: false,
        template: buildJobExecutionTemplate("assist")
    },

    "job-execute-auto": {
        agent: "design",
        description: "Execute job autonomously in new session and move job to .agents/jobs/executing/{name}/",
        subtask: false,
        template: buildJobExecutionTemplate("auto")
    },

    "job-execute": {
        agent: "temp_agent",
        description: "Select and execute job in the current session.",
        subtask: false,
        template: `
1. Call \`autocode_job_list\` to list all available jobs.
2. Call \`question\` once with exactly two batched questions:
    - Choose one available job from \`autocode_job_list\` output.
    - Choose execution agent: \`auto\` or \`assist\`.
3. Call \`autocode_plan_read\` with selected \`job_name\` to read the selected job plan.
4. Call \`autocode_agent_swap\` with \`agent\` set to the selected agent.
`
    },

    "job-review": {
        agent: "auto",
        description: "Commit accepted work and shelve into .agents/jobs/shelved/{name}/",
        subtask: false,
        template: `
1. Call \`autocode_criteria_list\` tool, if output show any unmet criteria, then inform user about unmet criteria and stop.
2. If this is git repo, then base your git commit message on plan of this job and Review Report.
3. Lastly when done, call \`autocode_shelve\` to shelve accepted review into \`.agents/jobs/shelved/{name}/\`, then stop.
`
    },

    "job-shelved": {
        agent: "auto",
        description: "Shelve current job and move job to .agents/jobs/shelved/{name}/",
        subtask: false, 
        template: "Call \`autocode_shelve\` to shelve job into \`.agents/jobs/shelved/{name}/\`, then stop."
    },

    "shelve": {
        agent: "auto",
        description: "Shelve current job and move job to .agents/jobs/shelved/{name}/",
        subtask: false,
        template: "Call \`autocode_shelve\` to shelve job into \`.agents/jobs/shelved/{name}/\`, then stop."
    },

    // Ad-hoc commands

    "author-article": {
        agent: "execute_author",
        description: "Author a professional article/report.",
        subtask: false,
        template: `$ARGUMENTS

_____________________________

Apply \`author-article\` skill to edit user provided article.`
    },

    "document": {
        agent: "document",
        description: "Document recent project changes.",
        subtask: false,
        template: `
1. Determine responsible subagents to document recent project changes: \`document_conventions\`, \`document_code\`, \`document_install\`, \`document_prd\`, \`document_ux\`
2. Task responsible subagent with instruction to update their SKILL.md file with only relevant changes (include only related changes in prompt - must match subagent description).
3. Collect subagent reports
4. Update \`README.md\` using collected reports (only update applicable sections - not entire file)
5. Only task \`document_agents\` *AFTER* you had updated \`README.md\` with prompt to check if any of recent changes are applicable to content in AGENTS.md (only update AGENTS.md if outdated)
`,
    },

    "document-conventions": {
        agent: "document_conventions",
        description: "Document recently updated naming conventions and terminology.",
        subtask: false,
        template: `$ARGUMENTS`,
    },

    "document-code": {
        agent: "document_code",
        description: "Document recently updated technical architecture and design decisions.",
        subtask: false,
        template: `$ARGUMENTS`,
    },

    "document-prd": {
        agent: "document_prd",
        description: "Document recently updated product requirements and user roles.",
        subtask: false,
        template: `$ARGUMENTS`,
    },

    "document-ux": {
        agent: "document_ux",
        description: "Document recently updated UX flows, navigation, and styling patterns.",
        subtask: false,
        template: `$ARGUMENTS`,
    },

    "git-commit": {
        agent: "execute_git_commit",
        description: "Automatically commit staged changes.",
        subtask: false,
        template: `
Base your git commit message on the following:
  - Purpose of this session (see title)
  - Your recent conversation with user
  - Recent changes
`
    },

    "git-conflict": {
        agent: "assist_git_conflict",
        description: "Automatically handle git merge conflicts.",
        subtask: false,
        template: `$ARGUMENTS`
    },

    "install": installCommand,

    "autocode-install": installCommand,

    "init": {
        agent: "execute_document",
        description: "Document the entire project.",
        subtask: true,
        template: `
1. Task subagents in parallel: \`document_conventions\`, \`document_code\`, \`document_install\`, \`document_prd\` 
2. Additionally task \`document_ux\` for frontend/web projects
3. Collect all subagent reports
4. Use \`author-readme\` skill to update \`README.md\` using collected reports
5. Only task \`document_agents\` *AFTER* you had updated \`README.md\` because \`document_agents\` will read your updated \`README.md\` file
        `
    },

    "new-assist": {
        agent: "temp_session",
        description: "Assist task execution in new session.",
        subtask: false,
        template: buildNewSessionTemplate("assist", `with recent user instructions to solve recently mentioned problem which includes:
    - PROBLEMS = Brief background context and wrong/missing behavior/info (undesired symptoms)
    - REQUIREMENTS = Expected system behavior / use case / answer to query
    - CONSTRAINTS = research scope (domain) or fixed technical/legal limits (facts) like security measures, dependencies, performance limitations, maintainability limitations, failure handling, reversibility, etc.
    - RISKS = any uncertainties (inaccessible/conflicting info), *assumed* limitations (edge-case concerns), external blockers (uncontrollable events/dependencies preventing solution), assumed caused of problem
    - PROPOSAL = only include if user suggested a solution
    - DATA = proof (all known paths/links to sources or facts), previous tool output, research results, exact values provided by user (do not repeat already included data)`, "Assist task execution session")
    },

    "new-auto": {
        agent: "temp_session",
        description: "Autonomously execute task in new session.",
        subtask: false,
        template: buildNewSessionTemplate("auto", `with recent user instructions to solve recently mentioned problem which includes:
    - PROBLEMS = Brief background context and wrong/missing behavior/info (undesired symptoms)
    - REQUIREMENTS = Expected system behavior / use case / answer to query
    - CONSTRAINTS = research scope (domain) or fixed technical/legal limits (facts) like security measures, dependencies, performance limitations, maintainability limitations, failure handling, reversibility, etc.
    - RISKS = any uncertainties (inaccessible/conflicting info), *assumed* limitations (edge-case concerns), external blockers (uncontrollable events/dependencies preventing solution), assumed caused of problem
    - PROPOSAL = only include if user suggested a solution
    - DATA = proof (all known paths/links to sources or facts), previous tool output, research results, exact values provided by user (do not repeat already included data)`, "Follow autonomous task execution session")
    },

    "new-design": {
        agent: "temp_session",
        description: "Design solutions in new session.",
        subtask: false,
        template: buildNewSessionTemplate("design", `with instructions to design solution plan according based on:
    - how: suggested cause of action
    - what: expectation of new session
    - why: brief background context
    - context: all known facts related to instruction such as (past actions + its outcomes, failed attempts + reason for failure, constraints/opportunities discovered related to instruction)
    - proof: all known paths/links to sources of facts
    - data: previous tool output / research results / data provided by user (only include related to instruction; do not repeat already included data)`, "Advise design session")
    },

    "new-research": {
        agent: "temp_session",
        description: "Research topic in new session that produces a research report.",
        subtask: false,
        template: buildNewSessionTemplate("research", `with instructions to research topic based on:
    - subject: name what info is required based on recent reasoning / user conversation
    - context: include all known facts related to instruction such as (past actions + its outcomes, failed attempts + reason for failure, constraints/opportunities discovered related to instruction)
    - proof: all known paths/links to sources of facts
    - data: previous tool output / research results / data provided by user (only include related to instruction; do not repeat already included data)`, "Follow research session")
    },

    "new-troubleshoot": {
        agent: "temp_session",
        description: "Troubleshoot issue in new session.",
        subtask: false,
        template: buildNewSessionTemplate("assist_troubleshoot", `with instructions that include:
    - SYMPTOMS = recently observed unexpected/wrong behavior 
    - ENVIRONMENT = environment context where SYMPTOM occurs (like OS, runtime version, profile, config)
    - BACKGROUND = why assignment is needed (if known)
    - CHANGES = what you recently changed that might be relevant to obstacle
    - EXPECTATION = what is expected to happen (like "respond 200 OK")
    - CAUSE = what possibly caused SYMPTOM (like "new auth library is incorrectly implemented")
    - EVIDENCE = facts that support theory of CAUSE (include blockcode of actual data, snippets of code, filenames, line numbers, urls, etc)
    - ERROR = EVIDENCE observed facts about SYMPTOM (like specific error message, stack trace, or exception)
    - TRACE = where ERROR was observed (like trace_id, log file, line number, timestamp, surrounding log messages, etc)
    - REPRODUCTION = steps to reproduce SYMPTOM in ENVIRONMENT include sample input data in blockcode (if possible)`, "Follow troubleshoot session")
    },

    "repeat-as-md": {
        agent: "assist",
        description: "Repeat the last response inside a fenced Markdown code block.",
        subtask: false,
        template: `
Repeat your last response wrapped in markdown codeblock:

For example:

\`\`\`\`\`\`\`\`\`markdown
Last response goes here...
\`\`\`\`\`\`\`\`\`        
`
    },

    "repeat-as-wiki": {
        agent: "assist",
        description: "Repeat last response in Atlassian Wiki Markup",
        subtask: false,
        template: `
Repeat your last response as Markdown block text in Atlassian Wiki Markup (Jira Wiki syntax) format:

For example:

\`\`\`\`\`\`\`\`\`markdown
Wiki markup goes here...
\`\`\`\`\`\`\`\`\`        
`
    },

    "report-session": {
        agent: "temp_report",
        description: "Provide detailed report of entire session.",
        subtask: false,
        template: "Report on entire session taking all actions, tool outputs and prompts in consideration."
    },

    "report-task": {
        agent: "temp_report",
        description: "Provide detailed report of recent task.",
        subtask: false,
        template: "Report **ONLY** on your last assignment (last user requested task). Include only last user prompt, recent actions since last user prompt and recent tool outputs into consideration when you compile the report."
    },

    "resume": {
        description: "Resume interrupted session.",
        subtask: false,
        template: "You were interrupted. Call \`task_resume\` tool, then resume your own work."
    },

}
