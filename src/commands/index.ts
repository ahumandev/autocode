import type { Config } from "@opencode-ai/sdk/v2"
import packageJson from "../../package.json"
import type { PlatformCapabilities } from "../utils/platform"
import { authorArticleCommandTemplate } from "./author-article"
import { documentCommandTemplate as docsCommandTemplate } from "./docs"
import { docsSubagentCommandTemplate } from "./docs-subagent"
import { explainCommandTemplate } from "./explain"
import { fixCommandTemplate } from "./fix"
import { gitCommitCommandTemplate } from "./commit"
import { gitConflictCommandTemplate } from "./git-conflict"
import { createInstallCommand } from "./install"
import { jobConceptsCommandTemplate } from "./job-concepts"
import { jobDesignCommandTemplate } from "./job-design"
import { jobDraftCommandTemplate } from "./job-draft"
import { jobExecuteCommandTemplate } from "./job-execute"
import { jobFacilitateCommandTemplate } from "./job-facilitate"
import { learnCommand } from "./learn"
import { repeatAsMdCommandTemplate } from "./repeat-as-md"
import { repeatAsWikiCommandTemplate } from "./repeat-as-wiki"
import { testsCommandTemplate } from "./tests"
import { reportCommandTemplate } from "./report"
import { restartSessionTemplate } from "./restart-session"

type CommandMap = NonNullable<Config["command"]>

export function createCommands(capabilities: PlatformCapabilities): CommandMap {
    const installCommand = createInstallCommand(capabilities)
    return {

    // Job lifecycle commands

    "job-concepts": { agent: "design", description: "Save concepts in .agents/jobs/concepts/.", template: jobConceptsCommandTemplate },
    "job-design": { agent: "design", description: "Design new plan based on existing concept or job.", subtask: false, template: jobDesignCommandTemplate },
    "job-draft": { agent: "design", description: "Draft proposed plan in .agents/jobs/drafts/{name}/plan.md", subtask: false, template: jobDraftCommandTemplate },
    "job-execute": { agent: "design", description: "Execute job autonomously in new session and move job to .agents/jobs/executing/{name}/", subtask: false, template: jobExecuteCommandTemplate },
    "job-facilitate": { agent: "design", description: "Facilitate job execution in new session. Job will move to .agents/jobs/facilitate/{name}/.", subtask: false, template: jobFacilitateCommandTemplate },
    "job-shelve": { agent: "auto", description: "Shelve current job and move job to .agents/jobs/shelved/{name}/", subtask: false, template: "Call `autocode_job_shelve` tool, then stop." },

    // Agent swaps

    "assist": { description: "Continue assist task execution in same session.", subtask: false, template: restartSessionTemplate("assist", "Solve PROBLEM by following 'Assist Workflow' steps.") },
    "auto": { description: "Continue autonomous task execution in same session.", subtask: false, template: restartSessionTemplate("auto", "Solve PROBLEM by following 'Auto Workflow' steps.") },
    "design": { description: "Continue solution design in same session.", subtask: false, template: restartSessionTemplate("design", "Design SOLUTION for PROBLEM by following 'Design Workflow' steps.") },
    "advise": { description: "Research topics and continue manual practice guidance in same session.", subtask: false, template: restartSessionTemplate("advise", "Research topic and teach manual fixes by following 'Assistant Workflow' steps.") },

    // Ad-hoc commands

    "autocode-install": installCommand,
    "autocode-version": { description: "Output AutoCode plugin version.", subtask: false, template: `
Report to user:

* Opencode version: !\`opencode --version\`
* Autocode version: !\`echo ${packageJson.version}\`
` },
    "author": { agent: "execute_author", description: "Author a professional article/report.", subtask: false, template: authorArticleCommandTemplate },
    "commit": { description: "Commit added changes to Git and shelve job: args = reason for commit", subtask: false, template: gitCommitCommandTemplate },
    "docs": { agent: "execute_document", description: "Document recent project changes.", subtask: false, template: docsCommandTemplate },
    "docs-conventions": { agent: "document_conventions", description: "Document recently updated naming conventions and terminology.", subtask: false, template: docsSubagentCommandTemplate },
    "docs-code": { agent: "document_code", description: "Document recently updated technical architecture and design decisions.", subtask: false, template: docsSubagentCommandTemplate },
    "docs-env": { agent: "document_env", description: "Document external integrations in local development environment.", subtask: false, template: docsSubagentCommandTemplate },
    "docs-prd": { agent: "document_prd", description: "Document recently updated product requirements and user roles.", subtask: false, template: docsSubagentCommandTemplate },
    "docs-ux": { agent: "document_ux", description: "Document recently updated UX flows, navigation, and styling patterns.", subtask: false, template: docsSubagentCommandTemplate },
    "explain": { agent: "query_code", description: "Explain code or project context", subtask: false, template: explainCommandTemplate },
    "fix": { agent: "auto_troubleshoot", description: "Fix errors or requested issues", subtask: false, template: fixCommandTemplate },
    "git-conflict": { agent: "assist_git_conflict", description: "Automatically handle git merge conflicts.", subtask: false, template: gitConflictCommandTemplate },
    "init": { agent: "execute_document", description: "Document the entire project.", subtask: true, template: docsCommandTemplate },
    "install": installCommand,
    "learn": learnCommand,
    "repeat-as-md": { description: "Repeat the last response inside a fenced Markdown code block.", subtask: false, template: repeatAsMdCommandTemplate },
    "repeat-as-wiki": { description: "Repeat last response in Atlassian Wiki Markup", subtask: false, template: repeatAsWikiCommandTemplate },
    "report": { description: "Summarize session as report.", subtask: false, template: reportCommandTemplate },
    "resume": { description: "Resume interrupted session.", subtask: false, template: "You were interrupted. Call `task_resume` tool, then resume your own work." },
    "tests": { agent: "auto_test", description: "Generate or improve tests", subtask: false, template: testsCommandTemplate }
    }
}
