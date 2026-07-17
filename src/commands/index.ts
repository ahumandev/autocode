import type { Config } from "@opencode-ai/sdk/v2"
import packageJson from "../../package.json"
import { authorArticleCommandTemplate } from "./author-article"
import { documentCommandTemplate as docsCommandTemplate } from "./docs"
import { docsSubagentCommandTemplate } from "./docs-subagent"
import { explainCommandTemplate } from "./explain"
import { fixCommandTemplate } from "./fix"
import { gitCommitCommandTemplate } from "./git-commit"
import { gitConflictCommandTemplate } from "./git-conflict"
import { installCommand } from "./install"
import { jobConceptsCommandTemplate } from "./job-concepts"
import { jobDesignCommandTemplate } from "./job-design"
import { jobDraftCommandTemplate } from "./job-draft"
import { jobExecuteCommandTemplate } from "./job-execute"
import { jobExecuteAssistCommandTemplate } from "./job-execute_assist"
import { jobExecuteAutoCommandTemplate } from "./job-execute_auto"
import { jobReviewCommitCommandTemplate } from "./job-review-commit"
import { newAssistCommandTemplate } from "./new-assist"
import { newAutoCommandTemplate } from "./new-auto"
import { newDesignCommandTemplate } from "./new-design"
import { newResearchCommandTemplate } from "./new-research"
import { newTroubleshootCommandTemplate } from "./new-troubleshoot"
import { repeatAsMdCommandTemplate } from "./repeat-as-md"
import { repeatAsWikiCommandTemplate } from "./repeat-as-wiki"
import { testsCommandTemplate } from "./tests"
import { reportCommandTemplate } from "./report"

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

const shelveCommandTemplate = "Call `autocode_job_shelve` to shelve job into `.agents/jobs/shelved/{name}/`, then stop."

export const commands: CommandMap = {

    // Job lifecycle commands

    "job-concepts": {
        agent: "design",
        description: "Save concepts in .agents/jobs/concepts/.",
        template: jobConceptsCommandTemplate,
    },

    "job-design": {
        agent: "design",
        description: "Design job plan from a concept in .agents/jobs/concepts/",
        subtask: false,
        template: jobDesignCommandTemplate,
    },

    "job-draft": {
        agent: "design",
        description: "Draft proposed plan in .agents/jobs/drafts/{name}/plan.md",
        subtask: false,
        template: jobDraftCommandTemplate,
    },

    "job-execute-assist": {
        agent: "design",
        description: "Assist with job execution in new session. Job will move to .agents/jobs/assist/{name}/.",
        subtask: false,
        template: jobExecuteAssistCommandTemplate,
    },

    "job-execute-auto": {
        agent: "design",
        description: "Execute job autonomously in new session and move job to .agents/jobs/executing/{name}/",
        subtask: false,
        template: jobExecuteAutoCommandTemplate,
    },

    "job-execute": {
        agent: "design",
        description: "Select and execute job in the current session.",
        subtask: false,
        template: jobExecuteCommandTemplate,
    },

    "job-review-commit": {
        agent: "auto",
        description: "Commit and shelve reviewed job from .agents/jobs/review/{name}/",
        subtask: false,
        template: jobReviewCommitCommandTemplate,
    },

    "job-shelve": {
        agent: "temp_shelve",
        description: "Shelve current job and move job to .agents/jobs/shelved/{name}/",
        subtask: false,
        template: shelveCommandTemplate,
    },

    "shelve": {
        agent: "temp_shelve",
        description: "Shelve current job and move job to .agents/jobs/shelved/{name}/",
        subtask: false,
        template: shelveCommandTemplate,
    },

    // Ad-hoc commands

    "autocode-install": installCommand,

    "autocode-version": {
        description: "Output AutoCode plugin version.",
        subtask: false,
        template: `
Report to user:

* Opencode version: !\`opencode --version\`
* Autocode version: !\`echo ${packageJson.version}\`
`,
    },

    "author-article": {
        agent: "execute_author",
        description: "Author a professional article/report.",
        subtask: false,
        template: authorArticleCommandTemplate,
    },

    "docs": {
        agent: "execute_document",
        description: "Document recent project changes.",
        subtask: false,
        template: docsCommandTemplate,
    },

    "docs-conventions": {
        agent: "document_conventions",
        description: "Document recently updated naming conventions and terminology.",
        subtask: false,
        template: docsSubagentCommandTemplate,
    },

    "docs-code": {
        agent: "document_code",
        description: "Document recently updated technical architecture and design decisions.",
        subtask: false,
        template: docsSubagentCommandTemplate,
    },

    "docs-env": {
        agent: "document_env",
        description: "Document external integrations in local development environment.",
        subtask: false,
        template: docsSubagentCommandTemplate,
    },

    "docs-prd": {
        agent: "document_prd",
        description: "Document recently updated product requirements and user roles.",
        subtask: false,
        template: docsSubagentCommandTemplate,
    },

    "docs-ux": {
        agent: "document_ux",
        description: "Document recently updated UX flows, navigation, and styling patterns.",
        subtask: false,
        template: docsSubagentCommandTemplate,
    },

    "explain": {
        agent: "query_code",
        description: "Explain code or project context",
        subtask: false,
        template: explainCommandTemplate,
    },

    "fix": {
        agent: "auto_troubleshoot",
        description: "Fix errors or requested issues",
        subtask: false,
        template: fixCommandTemplate,
    },

    "git-commit": {
        description: "Commit added changes to Git: args = reason for commit",
        subtask: false,
        template: gitCommitCommandTemplate,
    },

    "git-conflict": {
        agent: "assist_git_conflict",
        description: "Automatically handle git merge conflicts.",
        subtask: false,
        template: gitConflictCommandTemplate,
    },

    "init": {
        agent: "execute_document",
        description: "Document the entire project.",
        subtask: true,
        template: docsCommandTemplate,
    },

    "install": installCommand,

    "new-assist": {
        description: "Assist task execution in new session.",
        subtask: false,
        template: newAssistCommandTemplate,
    },

    "new-auto": {
        description: "Autonomously execute task in new session.",
        subtask: false,
        template: newAutoCommandTemplate,
    },

    "new-design": {
        description: "Design solutions in new session.",
        subtask: false,
        template: newDesignCommandTemplate,
    },

    "new-research": {
        description: "Research topic in new session.",
        subtask: false,
        template: newResearchCommandTemplate,
    },

    "new-troubleshoot": {
        description: "Troubleshoot issue in new session.",
        subtask: false,
        template: newTroubleshootCommandTemplate,
    },

    "repeat-as-md": {
        description: "Repeat the last response inside a fenced Markdown code block.",
        subtask: false,
        template: repeatAsMdCommandTemplate,
    },

    "repeat-as-wiki": {
        description: "Repeat last response in Atlassian Wiki Markup",
        subtask: false,
        template: repeatAsWikiCommandTemplate,
    },

    "report": {
        description: "Summarize session as report.",
        subtask: false,
        template: reportCommandTemplate,
    },

    "resume": {
        description: "Resume interrupted session.",
        subtask: false,
        template: "You were interrupted. Call `task_resume` tool, then resume your own work.",
    },

    "tests": {
        agent: "auto_test",
        description: "Generate or improve tests",
        subtask: false,
        template: testsCommandTemplate,
    },
}
