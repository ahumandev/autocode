import { describe, expect, test } from "bun:test"
import { commands } from "./index"

describe("commands", () => {
    test("keeps current command keys and command object shape", () => {
        expect(Object.keys(commands)).toEqual([
            "job-concepts",
            "job-design",
            "job-draft",
            "job-execute-assist",
            "job-execute-auto",
            "job-execute",
            "job-review",
            "job-shelve",
            "shelve",
            "autocode-install",
            "autocode-version",
            "author-article",
            "document",
            "document-conventions",
            "document-code",
            "document-prd",
            "document-ux",
            "git-commit",
            "git-conflict",
            "install",
            "init",
            "new-assist",
            "new-auto",
            "new-design",
            "new-research",
            "new-troubleshoot",
            "repeat-as-md",
            "repeat-as-wiki",
            "report-last",
            "report-session",
            "resume",
        ])

        for (const [commandName, command] of Object.entries(commands)) {
            expect(command).toEqual(expect.objectContaining({
                subtask: commandName === "init",
                template: expect.any(String),
            }))
            expect(command.template).not.toBe("")
            if ("description" in command) expect(command.description).toEqual(expect.any(String))
            if ("agent" in command) expect(command.agent).toEqual(expect.any(String))
            if ("model" in command) expect(command.model).toEqual(expect.any(String))
        }
    })

    test("keeps duplicated job execution command template intent", () => {
        expect(commands["job-execute-assist"]?.template).toContain("Call `autocode_job_execute` with `agent` = `assist`")
        expect(commands["job-execute-auto"]?.template).toContain("Call `autocode_job_execute` with `agent` = `auto`")
        for (const commandName of ["job-execute-assist", "job-execute-auto"] as const) {
            const template = commands[commandName]?.template ?? ""
            expect(template).toContain('`result_type == "draft_required"`')
            expect(template).toContain('`result_type == "no_plans"`')
            expect(template).toContain('`result_type == "session_created"`')
            expect(template).toContain('Follow job at new session called: "[session_title]".')
            expect(template).toContain("Replace [session_title] with `session_title` value from `autocode_job_execute` tool response.")
        }
    })

    test("keeps key command template substrings stable without legacy command", () => {
        const legacyCommand = ["job-termi", "nate"].join("")

        expect(commands["job-design"]?.template).toContain("Call `autocode_concept_list` tool to list available concepts.")
        expect(commands["job-draft"]?.template).toContain("Call `autocode_plan_save` tool with planned sections: PROBLEMS, IMPACT, EXPECTATIONS, REQUIREMENTS, RISKS, CONSTRAINTS, and user chosen PROPOSAL.")
        expect(commands["job-draft"]?.template).not.toContain("OBSERVATION")
        expect(commands["job-execute"]?.template).toContain("Call `autocode_agent_execute` once with selected `job_name` and selected `agent`, then evaluate tool output:")
        expect(commands["job-execute"]?.template).toContain('output includes `current_status`')
        expect(commands["job-execute"]?.template).toContain('Continue job in [agent] session.')
        expect(commands["job-review"]?.template).toContain("Call `autocode_criteria_list` tool, if output show any unmet criteria")
        expect(commands["job-shelve"]?.template).toContain("Call `autocode_job_shelve` to shelve job into `.agents/jobs/shelved/{name}/`")
        expect(commands["shelve"]?.template).toContain("Call `autocode_job_shelve` to shelve job into `.agents/jobs/shelved/{name}/`")
        expect(commands[legacyCommand]).toBeUndefined()
        expect(commands["init"]?.template).toContain("Task subagents in parallel: `document_conventions`, `document_code`, `document_install`, `document_prd`")
        expect(commands["resume"]?.template).toContain("Call `task_resume` tool")
    })

    test("keeps shared return-to-previous-primary rule on command templates", () => {
        const commandNames = [
            "author-article",
            "document",
            "document-conventions",
            "document-code",
            "document-prd",
            "document-ux",
            "git-commit",
            "git-conflict",
            "init",
            "job-concepts",
            "report-last",
            "report-session",
        ] as const

        for (const commandName of commandNames) {
            const template = commands[commandName]?.template ?? ""
            expect(template).toContain("call `autocode_agent_previous`")
            expect(template).not.toContain("autocode_agent_swap` with `agent` = `assist`")
        }
    })

    test("keeps init documentation-only", () => {
        const template = commands.init?.template ?? ""

        expect(commands.init?.agent).toBe("execute_document")
        expect(template).toContain("Task subagents in parallel: `document_conventions`, `document_code`, `document_install`, `document_prd`")
        expect(template).toContain("Use `author-readme` skill to update `README.md` using collected reports")
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
        expect(template).toContain("git_mcp")
        expect(template).toContain("browser")
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
        expect(template).toContain("Do not perform documentation tasks")
        expect(template).toContain("do not task any `document_*` subagents")
        expect(template).not.toContain("document_conventions")
        expect(template).not.toContain("document_code")
        expect(template).not.toContain("document_install")
        expect(template).not.toContain("document_prd")
        expect(template).not.toContain("document_ux")
        expect(template).not.toContain("README")
    })

    test("keeps duplicated new session command template intent", () => {
        const sessionCommands = {
            "new-assist": { agent: "assist", response: "Assist task execution session" },
            "new-auto": { agent: "auto", response: "Follow autonomous task execution session" },
            "new-design": { agent: "design", response: "Advise design session" },
            "new-research": { agent: "research", response: "Follow research session" },
            "new-troubleshoot": { agent: "assist_troubleshoot", response: "Follow troubleshoot session" },
        }

        for (const [commandName, expectation] of Object.entries(sessionCommands)) {
            const template = commands[commandName]?.template ?? ""
            expect(template).toContain(`Call \`autocode_session_create\` with \`agent\` = \`${expectation.agent}\``)
            expect(template).toContain(`${expectation.response}: "[session_title]".`)
            expect(template).toContain("Replace [session_title] with `session_title` value from `autocode_session_create` tool response.")
        }

        expect(commands["new-assist"]?.template).toContain("PROBLEMS = wrong/missing behavior or missing info according to user instructions")
        expect(commands["new-assist"]?.template).toContain("IMPACT = why issue matters to user/workflow/system")
        expect(commands["new-assist"]?.template).not.toContain("OBSERVATION")
        expect(commands["new-auto"]?.template).toContain("EXPECTATIONS = expected outcome or target behavior")
        expect(commands["new-auto"]?.template).toContain("REQUIREMENTS = required project changes or research scope, each with CRITERIA")
        expect(commands["new-auto"]?.template).not.toContain("OBSERVATION")
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
})
