import { describe, expect, test } from "bun:test"
import { docsCommandTemplate } from "./docs"
import { docsSubagentCommandTemplate } from "./docs-subagent"
import { explainCommandTemplate } from "./explain"
import { createCommands } from "./index"
import { learnCommand } from "./learn"
import { newSessionTemplate } from "./new-session"
import { testsCommandTemplate } from "./tests"
import { buildAgents } from "../agents"
import { createPlatformCapabilities } from "../utils/platform"

const commands = createCommands(createPlatformCapabilities("linux"))

describe("commands", () => {
    test("builds platform-specific install commands from supplied capabilities", () => {
        const linuxCommands = createCommands(createPlatformCapabilities("linux"))
        const cmdCommands = createCommands(createPlatformCapabilities("win32", {}))
        const powerShellCommands = createCommands(createPlatformCapabilities("win32", { PSModulePath: "present" }))

        expect(linuxCommands['autocode-install']?.template).toContain("If bwrap install is needed")
        expect(cmdCommands['autocode-install']?.template).toContain("Run commands in CMD")
        expect(powerShellCommands['autocode-install']?.template).toContain("Run commands in CMD")
    })

    test("keeps current command keys and command object shape", () => {
        expect(Object.keys(commands)).toEqual([
            "job-concepts",
            "new-advise",
            "new-assist",
            "new-auto",
            "new-design",
            "new-fix",
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
            "git-conflict",
            "init",
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

        for (const commandName of ["document", "document-conventions", "document-code", "document-prd", "document-ux", "execute-opencode", "execute_opencode", "git-commit", "help", "rename", "review", "act", "ask", "advise", "assist", "auto", "design", "fix", "job-assist", "job-auto", "job-design", "job-execute", "job-facilitate"] as const) {
            expect(commands[commandName]).toBeUndefined()
        }

        expect(Object.values(commands).some((command) => "agent" in command && command.agent === "execute_opencode")).toBe(false)
    })

    test("keeps standard command registrations stable", () => {
        expect(commands.explain).toMatchObject({
            agent: "query-code",
            subtask: false,
            template: explainCommandTemplate,
        })
        expect(commands["new-fix"]).toMatchObject({
            subtask: false,
            template: newSessionTemplate("auto-troubleshoot", "Proposed current APPROACH to SOLUTION (list GOALS and STEPS to achieve SOLUTION)", "Continue with 'Workflow Loop'."),
        })
        expect(commands.tests).toMatchObject({
            agent: "auto-test",
            subtask: false,
            template: testsCommandTemplate,
        })

        for (const commandName of ["context", "explain", "tests"] as const) {
            expect(commands[commandName]?.description).not.toBe("")
        }
    })

    test("distills recent context before handing off auto and assist sessions", () => {
        for (const [commandName, agent] of [["new-auto", "auto"], ["new-assist", "assist"]] as const) {
            const template = commands[commandName]?.template ?? ""

            expect(template).toContain("Call `autocode_session_context` first")
            expect(template.indexOf("autocode_session_context")).toBeLessThan(template.indexOf("autocode_session_create"))
            expect(template).toContain("GOALS")
            expect(template).toContain("IMPACT")
            expect(template).toContain("CONSTRAINTS")
            expect(template).toContain("CRITERIA")
            expect(template).toContain("Unfinished work")
            expect(template).toContain("$ARGUMENTS")
            expect(template).toContain("Redact secrets, tokens, credentials, and private keys")
            expect(template).toContain("complete handoff prompt as `prompt`")
            expect(template).toContain(`agent="${agent}"`)
        }
    })

    test("every explicit command target resolves in the current agent registry", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true }, [], { balanced: {}, smart: {}, spy: {} })
        const targets = Object.entries(commands)
            .flatMap(([commandName, command]) => "agent" in command && typeof command.agent === "string" ? [[commandName, command.agent] as const] : [])

        expect(targets).toHaveLength(13)
        expect(Object.fromEntries(targets)).toEqual({
            "job-concepts": "design",
            "autocode-install": "execute-os",
            author: "execute-author",
            docs: "execute-document",
            "docs-conventions": "document-conventions",
            "docs-code": "document-code",
            "docs-env": "document-env",
            "docs-prd": "document-prd",
            "docs-ux": "document-ux",
            explain: "query-code",
            "git-conflict": "assist_git_conflict",
            init: "execute-document",
            tests: "auto-test",
        })
        for (const [commandName, agentId] of targets) {
            expect(agents[agentId], `${commandName} targets registered agent ${agentId}`).toBeDefined()
        }
    })

    test("registers new-spy only when spy is available", () => {
        const commandsWithSpy = createCommands(createPlatformCapabilities("linux"), true)

        expect(commands["new-spy"]).toBeUndefined()
        expect(commandsWithSpy["new-spy"]).toMatchObject({
            subtask: false,
            template: newSessionTemplate("spy", "Proposed current APPROACH to collect EVIDENCE and answer QUESTION", "Gather evidence with permitted read-only tools, then report facts and answer QUESTION."),
        })
    })

    test("omits optional-agent commands without hiding generic commands", () => {
        const commandsWithoutOptionalAgents = createCommands(createPlatformCapabilities("linux"), false, false)

        expect(commandsWithoutOptionalAgents["new-auto"]).toBeUndefined()
        expect(commandsWithoutOptionalAgents["new-spy"]).toBeUndefined()
        expect(commandsWithoutOptionalAgents["new-assist"]).toBeDefined()
        expect(commandsWithoutOptionalAgents.docs).toBeDefined()
    })

    test("keeps renamed docs command objects stable", () => {
        expect(commands.docs).toMatchObject({
            agent: "execute-document",
            subtask: false,
            template: docsCommandTemplate,
        })
        expect(commands["docs-conventions"]).toMatchObject({
            agent: "document-conventions",
            subtask: false,
            template: docsSubagentCommandTemplate,
        })
        expect(commands["docs-code"]).toMatchObject({
            agent: "document-code",
            subtask: false,
            template: docsSubagentCommandTemplate,
        })
        expect(commands["docs-prd"]).toMatchObject({
            agent: "document-prd",
            subtask: false,
            template: docsSubagentCommandTemplate,
        })
        expect(commands["docs-ux"]).toMatchObject({
            agent: "document-ux",
            subtask: false,
            template: docsSubagentCommandTemplate,
        })

        for (const commandName of ["docs", "docs-conventions", "docs-code", "docs-env", "docs-prd", "docs-ux"] as const) {
            expect(commands[commandName]?.agent).not.toBe("advise")
        }
    })

    test("keeps key command template substrings stable", () => {
        expect(commands.commit?.subtask).toBe(false)
        expect(commands.commit?.template).toContain("$ARGUMENTS")
        expect(commands.commit?.template).toContain("git_commit")
        expect(commands.commit?.template).toContain("NEVER any other tool")
        expect(commands.resume?.subtask).toBe(false)
        expect(commands.resume?.template).toContain("You were interrupted. Call `task_resume` tool, then resume your own work.")
    })

    test("keeps init documentation-only", () => {
        const template = commands.init?.template ?? ""

        expect(commands.init?.agent).toBe("execute-document")
        expect(template).toContain("Only task `document-agents` *AFTER*")
        expect(template).not.toContain("autocode_dependencies")
        expect(template).not.toContain("preflight")
        expect(template).not.toContain("bwrap")
        expect(template).not.toContain("opencode upgrade")
    })

    test("keeps install dependency remediation-only", () => {
        const template = commands["autocode-install"]?.template ?? ""
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
        expect(template).not.toContain("document-conventions")
        expect(template).not.toContain("document-code")
        expect(template).not.toContain("document-install")
        expect(template).not.toContain("document-prd")
        expect(template).not.toContain("document-ux")
        expect(template).not.toContain("README")
    })

    test("keeps repeat_as_md template intent independent of stale description", () => {
        const command = commands["repeat-as-md"]

        expect(command?.agent).toBeUndefined()
        expect(command?.subtask).toBe(false)
        expect(command?.template).toContain("Repeat your last response wrapped in markdown codeblock")
        expect(command?.template).toContain("Last response goes here")
        expect(command?.template).not.toContain("fenced Markdown code block")
    })

})
