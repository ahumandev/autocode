import type { Config } from "@opencode-ai/sdk/v2"
import packageJson from "../../package.json"
import { authorArticleCommandTemplate } from "./author_article"
import { documentCodeCommandTemplate } from "./document_code"
import { documentConventionsCommandTemplate } from "./document_conventions"
import { documentPrdCommandTemplate } from "./document_prd"
import { documentCommandTemplate } from "./document"
import { documentUxCommandTemplate } from "./document_ux"
import { gitCommitCommandTemplate } from "./git_commit"
import { gitConflictCommandTemplate } from "./git_conflict"
import { initCommandTemplate } from "./init"
import { installCommand } from "./install"
import { jobConceptsCommandTemplate } from "./job_concepts"
import { jobDesignCommandTemplate } from "./job_design"
import { jobDraftCommandTemplate } from "./job_draft"
import { jobExecuteCommandTemplate } from "./job_execute"
import { jobExecuteAssistCommandTemplate } from "./job_execute_assist"
import { jobExecuteAutoCommandTemplate } from "./job_execute_auto"
import { jobReviewCommandTemplate } from "./job_review"
import { newAssistCommandTemplate } from "./new_assist"
import { newAutoCommandTemplate } from "./new_auto"
import { newDesignCommandTemplate } from "./new_design"
import { newResearchCommandTemplate } from "./new_research"
import { newTroubleshootCommandTemplate } from "./new_troubleshoot"
import { repeatAsMdCommandTemplate } from "./repeat_as_md"
import { repeatAsWikiCommandTemplate } from "./repeat_as_wiki"
import { reportLastCommandTemplate } from "./report_last"
import { reportSessionCommandTemplate } from "./report_session"

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
        agent: "temp_concept",
        description: "Save concepts in .agents/jobs/concepts/.",
        subtask: false,
        template: jobConceptsCommandTemplate,
    },

    "job-design": {
        agent: "design",
        description: "Design a solution plan from a concept in .agents/jobs/concepts/",
        subtask: false,
        template: jobDesignCommandTemplate,
    },

    "job-draft": {
        agent: "design",
        description: "Save drafted solution plan in .agents/jobs/drafts/{name}/plan.md",
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
        agent: "temp_execute",
        description: "Select and execute job in the current session.",
        subtask: false,
        template: jobExecuteCommandTemplate,
    },

    "job-review": {
        agent: "execute_git_commit",
        description: "Commit accepted work and shelve into .agents/jobs/shelved/{name}/",
        subtask: false,
        template: jobReviewCommandTemplate,
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
        agent: "temp_output",
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

    "document": {
        agent: "document",
        description: "Document recent project changes.",
        subtask: false,
        template: documentCommandTemplate,
    },

    "document-conventions": {
        agent: "document_conventions",
        description: "Document recently updated naming conventions and terminology.",
        subtask: false,
        template: documentConventionsCommandTemplate,
    },

    "document-code": {
        agent: "document_code",
        description: "Document recently updated technical architecture and design decisions.",
        subtask: false,
        template: documentCodeCommandTemplate,
    },

    "document-prd": {
        agent: "document_prd",
        description: "Document recently updated product requirements and user roles.",
        subtask: false,
        template: documentPrdCommandTemplate,
    },

    "document-ux": {
        agent: "document_ux",
        description: "Document recently updated UX flows, navigation, and styling patterns.",
        subtask: false,
        template: documentUxCommandTemplate,
    },

    "git-commit": {
        agent: "execute_git_commit",
        description: "Automatically commit staged changes.",
        subtask: false,
        template: gitCommitCommandTemplate,
    },

    "git-conflict": {
        agent: "assist_git_conflict",
        description: "Automatically handle git merge conflicts.",
        subtask: false,
        template: gitConflictCommandTemplate,
    },

    "install": installCommand,

    "init": {
        agent: "execute_document",
        description: "Document the entire project.",
        subtask: true,
        template: initCommandTemplate,
    },

    "new-assist": {
        agent: "temp_session",
        description: "Assist task execution in new session.",
        subtask: false,
        template: newAssistCommandTemplate,
    },

    "new-auto": {
        agent: "temp_session",
        description: "Autonomously execute task in new session.",
        subtask: false,
        template: newAutoCommandTemplate,
    },

    "new-design": {
        agent: "temp_session",
        description: "Design solutions in new session.",
        subtask: false,
        template: newDesignCommandTemplate,
    },

    "new-research": {
        agent: "temp_session",
        description: "Research topic in new session that produces a research report.",
        subtask: false,
        template: newResearchCommandTemplate,
    },

    "new-troubleshoot": {
        agent: "temp_session",
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

    "report-last": {
        agent: "temp_report",
        description: "Provide detailed report of last task.",
        subtask: false,
        template: reportLastCommandTemplate,
    },

    "report-session": {
        agent: "temp_report",
        description: "Provide detailed report of entire session.",
        subtask: false,
        template: reportSessionCommandTemplate,
    },

    "resume": {
        description: "Resume interrupted session.",
        subtask: false,
        template: "You were interrupted. Call `task_resume` tool, then resume your own work.",
    },

}
