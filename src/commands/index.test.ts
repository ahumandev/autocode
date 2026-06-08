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
            "job-terminate",
            "author-article",
            "document",
            "document_conventions",
            "document_design",
            "document_prd",
            "document_ux",
            "git_commit",
            "git_conflict",
            "new-assist",
            "new-auto",
            "new-design",
            "new-research",
            "new-troubleshoot",
            "repeat_as_md",
            "repeat_as_wiki",
            "report-session",
            "report-task",
            "resume",
        ])

        for (const command of Object.values(commands)) {
            expect(command).toEqual(expect.objectContaining({
                subtask: false,
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
    })

    test("keeps repeat_as_md template intent independent of stale description", () => {
        const command = commands.repeat_as_md

        expect(command?.agent).toBe("assist")
        expect(command?.subtask).toBe(false)
        expect(command?.template).toContain("Repeat your last response wrapped in markdown codeblock")
        expect(command?.template).toContain("Last response goes here")
    })
})
