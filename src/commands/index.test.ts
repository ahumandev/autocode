import { describe, expect, test } from "bun:test"
import { documentCommandTemplate } from "./docs"
import { docsSubagentCommandTemplate } from "./docs-subagent"
import { explainCommandTemplate } from "./explain"
import { fixCommandTemplate } from "./fix"
import { createCommands } from "./index"
import { learnCommand } from "./learn"
import { testsCommandTemplate } from "./tests"
import { createPlatformCapabilities } from "../utils/platform"

const commands = createCommands(createPlatformCapabilities("linux"))

describe("commands", () => {
    test("builds platform-specific install commands from supplied capabilities", () => {
        const linuxCommands = createCommands(createPlatformCapabilities("linux"))
        const cmdCommands = createCommands(createPlatformCapabilities("win32", {}))
        const powerShellCommands = createCommands(createPlatformCapabilities("win32", { PSModulePath: "present" }))

        expect(linuxCommands.install?.template).toContain("If bwrap install is needed")
        expect(cmdCommands.install?.template).toContain("Run commands in CMD")
        expect(powerShellCommands.install?.template).toContain("Run commands in CMD")
    })

    test("keeps current command keys and command object shape", () => {
        expect(Object.keys(commands)).toEqual([
            "job-concepts",
            "job-design",
            "job-draft",
            "job-execute",
            "job-facilitate",
            "job-shelve",
            "assist",
            "auto",
            "design",
            "advise",
            "autocode-install",
            "autocode-version",
            "author",
            "commit",
            "docs",
            "docs-conventions",
            "docs-code",
            "docs-env",
            "docs-prd",
            "docs-ux",
            "explain",
            "fix",
            "git-conflict",
            "init",
            "install",
            "learn",
            "repeat-as-md",
            "repeat-as-wiki",
            "report",
            "resume",
            "tests",
        ])

        for (const [commandName, command] of Object.entries(commands)) {
            expect(command.template).toEqual(expect.any(String))
            expect(command.template).not.toBe("")
            if ("subtask" in command) expect(command.subtask).toBe(commandName === "init")
            if ("description" in command) expect(command.description).toEqual(expect.any(String))
            if ("agent" in command) expect(command.agent).toEqual(expect.any(String))
            if ("model" in command) expect(command.model).toEqual(expect.any(String))
        }

        for (const commandName of ["document", "document-conventions", "document-code", "document-prd", "document-ux", "execute-opencode", "execute_opencode", "git-commit", "help", "rename", "review", "act", "ask"] as const) {
            expect(commands[commandName]).toBeUndefined()
        }

        expect(Object.values(commands).some((command) => "agent" in command && command.agent === "execute_opencode")).toBe(false)
    })

    test("keeps standard command registrations stable", () => {
        expect(commands.explain).toEqual({
            agent: "query_code",
            description: "Explain code or project context",
            subtask: false,
            template: explainCommandTemplate,
        })
        expect(commands.fix).toEqual({
            agent: "auto_troubleshoot",
            description: "Fix errors or requested issues",
            subtask: false,
            template: fixCommandTemplate,
        })
        expect(commands.tests).toEqual({
            agent: "auto_test",
            description: "Generate or improve tests",
            subtask: false,
            template: testsCommandTemplate,
        })

        for (const commandName of ["context", "explain", "fix", "tests"] as const) {
            expect(commands[commandName]?.description).not.toBe("")
        }
    })

    test("keeps renamed docs command objects stable", () => {
        expect(commands.docs).toEqual({
            agent: "execute_document",
            description: "Document recent project changes.",
            subtask: false,
            template: documentCommandTemplate,
        })
        expect(commands["docs-conventions"]).toEqual({
            agent: "document_conventions",
            description: "Document recently updated naming conventions and terminology.",
            subtask: false,
            template: docsSubagentCommandTemplate,
        })
        expect(commands["docs-code"]).toEqual({
            agent: "document_code",
            description: "Document recently updated technical architecture and design decisions.",
            subtask: false,
            template: docsSubagentCommandTemplate,
        })
        expect(commands["docs-prd"]).toEqual({
            agent: "document_prd",
            description: "Document recently updated product requirements and user roles.",
            subtask: false,
            template: docsSubagentCommandTemplate,
        })
        expect(commands["docs-ux"]).toEqual({
            agent: "document_ux",
            description: "Document recently updated UX flows, navigation, and styling patterns.",
            subtask: false,
            template: docsSubagentCommandTemplate,
        })

        for (const commandName of ["docs", "docs-conventions", "docs-code", "docs-env", "docs-prd", "docs-ux"] as const) {
            expect(commands[commandName]?.agent).not.toBe("advise")
        }
    })

    test("keeps duplicated job execution command template intent", () => {
        expect(commands["job-facilitate"]?.template).toContain("Call `autocode_job_execute` with `agent` = `assist`")
        for (const commandName of ["job-facilitate", "job-execute"] as const) {
            const template = commands[commandName]?.template ?? ""
            expect(template).toContain('`result_type == "draft_required"`')
            expect(template).toContain('`result_type == "no_plans"`')
            expect(template).toContain('`result_type == "session_created"`')
        }
    })

    test("keeps key command template substrings stable", () => {
        expect(commands["job-design"]?.template).toContain("Call `autocode_concept_list` tool to list available concepts.")
        expect(commands["job-draft"]?.template).toContain("Call `autocode_job_draft` tool with planned sections: PROBLEMS, IMPACT, EXPECTATIONS, REQUIREMENTS, RISKS, CONSTRAINTS, and user chosen PROPOSAL.")
        expect(commands["job-draft"]?.template).not.toContain("OBSERVATION")
        expect(commands["job-execute"]?.template).toContain("Call `autocode_job_execute` with `agent` = `auto`")
        expect(commands.commit?.description).toBe("Commit added changes to Git and shelve job: args = reason for commit")
        expect(commands.commit?.subtask).toBe(false)
        expect(commands.commit?.template).toContain("$ARGUMENTS")
        expect(commands.commit?.template).toContain("git_commit")
        expect(commands.commit?.template).toContain("autocode_job_shelve")
        expect(commands.commit?.template).toContain("NEVER any other tool")
        expect(commands["job-shelve"]?.template).toContain("Call `autocode_job_shelve` tool, then stop.")
        expect(commands.resume?.description).toBe("Resume interrupted session.")
        expect(commands.resume?.subtask).toBe(false)
        expect(commands.resume?.template).toContain("You were interrupted. Call `task_resume` tool, then resume your own work.")
    })

    test("keeps init documentation-only", () => {
        const template = commands.init?.template ?? ""

        expect(commands.init?.agent).toBe("execute_document")
        expect(template).toContain("Only task `document_agents` *AFTER*")
        expect(template).not.toContain("autocode_dependencies")
        expect(template).not.toContain("preflight")
        expect(template).not.toContain("bwrap")
        expect(template).not.toContain("opencode upgrade")
    })

    test("keeps install dependency remediation-only", () => {
        const template = commands.install?.template ?? ""

        expect(commands.install?.agent).toBe("assist")
        expect(commands["autocode-install"]).toBe(commands.install)
        expect(commands["autocode-install"]?.description).toBe(commands.install?.description)
        expect(commands["autocode-install"]?.template).toBe(commands.install?.template)
        expect(template).toContain("Call `autocode_dependencies` first.")
        expect(template).toContain("Only treat as no issues")
        expect(template).toContain("report dependencies OK and stop")
        expect(template).toContain("Do not stop just because top-level `ok` is true")
        expect(template).toContain("suggested `opencode upgrade` command")
        expect(template).toContain("bwrap install is needed")
        expect(template).toContain("chrome_devtools_mcp")
        expect(template).toContain("context7_mcp")
        expect(template).toContain("excel_mcp")
        expect(template).toContain("git_cli")
        expect(template).toContain("system Git CLI")
        expect(template).not.toContain("git_mcp")
        expect(template).not.toContain("mcp-server-git")
        expect(template).toContain("After remediation, rerun `autocode_dependencies`")
        expect(template).toContain("autocode_dependencies")
        expect(template).toContain("continue after failures")
        expect(template).toContain("succeeded")
        expect(template).toContain("failed")
        expect(template).toContain("skipped")
        expect(template).toContain("unsupported")
        expect(template).toContain("manual-action")
        expect(template).toContain("still missing")
        expect(template).toContain("stop/ask/report")
        expect(template).toContain("dangerous")
        expect(template).toContain("sudo")
        expect(template).toContain("password")
        expect(template).toContain("API keys")
        expect(template).toContain("manual confirmation")
        expect(template).toContain("dangerous-operation/manual confirmation rules")
        expect(template).toContain("rerun `autocode_dependencies` and report remaining issues")
        expect(template).toContain("After summary report, perform no next action, just stop.")
        expect(template).not.toContain("document_conventions")
        expect(template).not.toContain("document_code")
        expect(template).not.toContain("document_install")
        expect(template).not.toContain("document_prd")
        expect(template).not.toContain("document_ux")
        expect(template).not.toContain("README")
    })

    test("keeps repeat_as_md template intent independent of stale description", () => {
        const command = commands["repeat-as-md"]

        expect(command?.agent).toBeUndefined()
        expect(command?.description).toBe("Repeat the last response inside a fenced Markdown code block.")
        expect(command?.subtask).toBe(false)
        expect(command?.template).toContain("Repeat your last response wrapped in markdown codeblock")
        expect(command?.template).toContain("Last response goes here")
        expect(command?.template).not.toContain("fenced Markdown code block")
    })

    test("registers learn command under assist with required reflection template", () => {
        expect(commands.learn).toEqual(learnCommand)
        expect(commands.learn?.agent).toBeUndefined()
        expect(commands.learn?.subtask).toBe(false)

        const template = commands.learn?.template ?? ""
        // Categorize into correction/env/permission/preference
        expect(template).toContain("correction")
        expect(template).toContain("env")
        expect(template).toContain("permission")
        expect(template).toContain("preference")
        expect(template).toContain("`skill_learn`")
        // Skip empty categories
        expect(template).toMatch(/skip.*categor/i)
        // $ARGUMENTS placeholder
        expect(template).toContain("$ARGUMENTS")
    })
})
