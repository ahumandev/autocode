import packageJson from "../../package.json"
import type { Config } from "@opencode-ai/sdk/v2"
import type { PlatformCapabilities } from "../utils/platform"
import { authorArticleCommandTemplate } from "./author-article"
import { createInstallCommand } from "./install"
import { docsCommandTemplate } from "./docs"
import { docsSubagentCommandTemplate } from "./docs-subagent"
import { explainCommandTemplate } from "./explain"
import { gitCommitCommandTemplate } from "./commit"
import { gitConflictCommandTemplate } from "./git-conflict"
import { jobAssistCommandTemplate } from "./job-assist"
import { jobAutoCommandTemplate } from "./job-auto"
import { jobConceptsCommandTemplate } from "./job-concepts"
import { jobDesignCommandTemplate } from "./job-design"
import { learnCommand } from "./learn"
import { newSessionTemplate } from "./new-session"
import { repeatAsMdCommandTemplate } from "./repeat-as-md"
import { repeatAsWikiCommandTemplate } from "./repeat-as-wiki"
import { reportCommandTemplate } from "./report"
import { testsCommandTemplate } from "./tests"

type CommandMap = NonNullable<Config["command"]>

export function createCommands(capabilities: PlatformCapabilities, spyAvailable = false): CommandMap {
    return {

        // Job workspace commands

        "job-auto": { agent: "design", description: "🚀 Start autonomous execution in a new session.", subtask: false, template: jobAutoCommandTemplate },
        "job-assist": { agent: "design", description: "🧑‍💻 Start assisted execution in a new session.", subtask: false, template: jobAssistCommandTemplate },
        "job-concepts": { agent: "design", description: "💭 Save concepts in .agents/concepts/.", template: jobConceptsCommandTemplate },
        "job-design": { agent: "design", description: "📐 Design solution from existing concept or job.", subtask: false, template: jobDesignCommandTemplate },

        // New session commands

        "new-advise": { description: "Create new 💡 advise session to research topics, answer questions, and guide manual work.", subtask: false, template: newSessionTemplate("advise", "Proposed current APPROACH to SOLUTION (list GOALS and STEPS to achieve SOLUTION)", "Use `todowrite` tool to create ASSIGNMENTS that will complete proposed SOLUTION") },
        "new-assist": { description: "Create new 🧑‍💻 assist session to semi-autonomously assist with problems/improvements.", subtask: false, template: newSessionTemplate("assist", "Proposed current APPROACH to SOLUTION (list GOALS and STEPS to achieve SOLUTION)", "Use `todowrite` tool to create ASSIGNMENTS that will complete proposed SOLUTION") },
        "new-auto":   { description: "Create new 🤖 auto session to autonomously solve problems.", subtask: false, template: newSessionTemplate("auto", "Proposed current APPROACH to SOLUTION (list GOALS and STEPS to achieve SOLUTION)", "Solve PROBLEM according 'Auto Workflow'.") },
        "new-design": { description: "Create new 📐 design session to design solution to problem.", subtask: false, template: newSessionTemplate("design", "Summarize how steps taken so far", "Design and suggest APPROACHES around discovered OBSTACLES within CONSTRAINTS.") },
        "new-fix":    { description: "Create new 🛠️ troubleshooting session to address obstacle, while keeping current session clean.", subtask: false, template: newSessionTemplate("auto_troubleshoot", "Proposed current APPROACH to SOLUTION (list GOALS and STEPS to achieve SOLUTION)", "Continue with 'Workflow Loop'.") },
        ...(spyAvailable ? {
            "new-spy": { description: "Create new 🕵️ spy session to inspect private information.", subtask: false, template: newSessionTemplate("spy", "Proposed current APPROACH to collect EVIDENCE and answer QUESTION", "Gather evidence with permitted read-only tools, then report facts and answer QUESTION.") },
        } : {}),

        // Ad-hoc commands

        "autocode-install": createInstallCommand(capabilities),
        "autocode-version": { description: "🏷️ Output AutoCode plugin version.", subtask: false, template: `
Report to user:

* Opencode version: !\`opencode --version\`
* Autocode version: !\`echo ${packageJson.version}\`
` },
        "author": { agent: "execute_author", description: "✍️ Author a professional article/report.", subtask: false, template: authorArticleCommandTemplate },
        "commit": { description: "📝 Commit added changes to Git: args = reason for commit", subtask: false, template: gitCommitCommandTemplate },
        "docs": { agent: "execute_document", description: "📚 Document recent project changes.", subtask: false, template: docsCommandTemplate },
        "docs-conventions": { agent: "document_conventions", description: "📖 Document recently updated naming conventions and terminology.", subtask: false, template: docsSubagentCommandTemplate },
        "docs-code": { agent: "document_code", description: "🏗️ Document recently updated technical architecture and design decisions.", subtask: false, template: docsSubagentCommandTemplate },
        "docs-env": { agent: "document_env", description: "🌐 Document external integrations in local development environment.", subtask: false, template: docsSubagentCommandTemplate },
        "docs-prd": { agent: "document_prd", description: "📋 Document recently updated product requirements and user roles.", subtask: false, template: docsSubagentCommandTemplate },
        "docs-ux": { agent: "document_ux", description: "🎨 Document recently updated UX flows, navigation, and styling patterns.", subtask: false, template: docsSubagentCommandTemplate },
        "explain": { agent: "query_code", description: "🔍 Explain code or project context", subtask: false, template: explainCommandTemplate },
        "git-conflict": { agent: "assist_git_conflict", description: "⚔️ Automatically handle git merge conflicts.", subtask: false, template: gitConflictCommandTemplate },
        "init": { agent: "execute_document", description: "📖 Document the entire project.", subtask: true, template: docsCommandTemplate },
        "learn": learnCommand,
        "repeat-as-md": { description: "🔁 Repeat the last response inside a fenced Markdown code block.", subtask: false, template: repeatAsMdCommandTemplate },
        "repeat-as-wiki": { description: "🔁 Repeat last response in Atlassian Wiki Markup", subtask: false, template: repeatAsWikiCommandTemplate },
        "report": { description: "📊 Summarize session as report.", subtask: false, template: reportCommandTemplate },
        "resume": { description: "▶️ Resume interrupted session.", subtask: false, template: "You were interrupted. Call `task_resume` tool, then resume your own work." },
        "tests": { agent: "auto_test", description: "🧪 Generate or improve tests", subtask: false, template: testsCommandTemplate }
    }
}
