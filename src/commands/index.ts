import type { Config } from "@opencode-ai/sdk/v2"
import packageJson from "../../package.json"
import type { PlatformCapabilities } from "../utils/platform"
import { authorArticleCommandTemplate } from "./author-article"
import { documentCommandTemplate as docsCommandTemplate } from "./docs"
import { docsSubagentCommandTemplate } from "./docs-subagent"
import { explainCommandTemplate } from "./explain"
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
import { newSessionTemplate } from "./new-session"

type CommandMap = NonNullable<Config["command"]>

export function createCommands(capabilities: PlatformCapabilities): CommandMap {
    const installCommand = createInstallCommand(capabilities)
    const assistCommand = { description: "Create new 🧑‍💻 assist session to semi-autonomously assist with problems/improvements.", subtask: false, template: newSessionTemplate("assist", "Proposed current APPROACH to SOLUTION (list GOALS and STEPS to achieve SOLUTION)", "Use `todowrite` tool to create ASSIGNMENTS that will complete proposed SOLUTION") }
    return {

        // Job lifecycle commands

        "job-concepts": { agent: "design", description: "Save concepts in .agents/jobs/concepts/.", template: jobConceptsCommandTemplate },
        "job-design": { agent: "design", description: "Design new plan based on existing concept or job.", subtask: false, template: jobDesignCommandTemplate },
        "job-draft": { agent: "design", description: "Draft proposed plan in .agents/jobs/drafts/{name}/plan.md", subtask: false, template: jobDraftCommandTemplate },
        "job-execute": { agent: "design", description: "Execute job autonomously in new session and move job to .agents/jobs/executing/{name}/", subtask: false, template: jobExecuteCommandTemplate },
        "job-facilitate": { agent: "design", description: "Facilitate job execution in new session. Job will move to .agents/jobs/facilitate/{name}/.", subtask: false, template: jobFacilitateCommandTemplate },
        "job-shelve": { agent: "auto", description: "Shelve current job and move job to .agents/jobs/shelved/{name}/", subtask: false, template: "Call `autocode_job_shelve` tool, then stop." },

        // New session commands

        assist: assistCommand,
        "new-advise": { description: "Create new 💡 advise session to research topics, answer questions, and guide manual work.", subtask: false, template: newSessionTemplate("advise", "Proposed current APPROACH to SOLUTION (list GOALS and STEPS to achieve SOLUTION)", "Use `todowrite` tool to create ASSIGNMENTS that will complete proposed SOLUTION") },
        "new-assist": assistCommand,
        "new-auto": { description: "Create new 🤖 auto session to autonomously solve problems.", subtask: false, template: newSessionTemplate("auto", "Proposed current APPROACH to SOLUTION (list GOALS and STEPS to achieve SOLUTION)", "Solve PROBLEM according 'Auto Workflow'.") },
        "new-design": { description: "Create new 📐 design session to design solution to problem.", subtask: false, template: newSessionTemplate("design", "Summarize how steps taken so far", "Design and suggest APPROACHES around discovered OBSTACLES within CONSTRAINTS.") },
        "new-fix": { description: "Fix errors in new session.", subtask: false, template: newSessionTemplate("auto_troubleshoot", "Proposed current APPROACH to SOLUTION (list GOALS and STEPS to achieve SOLUTION)", "Continue with 'Workflow Loop'.") },

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
        "git-conflict": { agent: "assist_git_conflict", description: "Automatically handle git merge conflicts.", subtask: false, template: gitConflictCommandTemplate },
        "init": { agent: "execute_document", description: "Document the entire project.", subtask: true, template: docsCommandTemplate },
        "learn": learnCommand,
        "repeat-as-md": { description: "Repeat the last response inside a fenced Markdown code block.", subtask: false, template: repeatAsMdCommandTemplate },
        "repeat-as-wiki": { description: "Repeat last response in Atlassian Wiki Markup", subtask: false, template: repeatAsWikiCommandTemplate },
        "report": { description: "Summarize session as report.", subtask: false, template: reportCommandTemplate },
        "resume": { description: "Resume interrupted session.", subtask: false, template: "You were interrupted. Call `task_resume` tool, then resume your own work." },
        "tests": { agent: "auto_test", description: "Generate or improve tests", subtask: false, template: testsCommandTemplate }
    }
}
