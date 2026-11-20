import { describe, expect, test } from "bun:test"
import { docsCommandTemplate } from "./docs"
import { docsSubagentCommandTemplate } from "./docs-subagent"
import { explainCommandTemplate } from "./explain"
import { createCommands } from "./index"
import { learnCommand } from "./learn"
import { newSessionTemplate } from "./new-session"
import { testsCommandTemplate } from "./tests"
import { buildAgents } from "../agents"
import { createTools } from "../tools"
import { createPlatformCapabilities } from "../utils/platform"
import type { OpencodeClient } from "@opencode-ai/sdk"

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
            "docs",
            "explain",
            "git-conflict",
            "init",
            "learn",
            "learn-conventions",
            "learn-code",
            "learn-env",
            "learn-prd",
            "learn-ux",
            "repeat-as-md",
            "repeat-as-wiki",
            "report",
            "tests",
        ])

        for (const [commandName, command] of Object.entries(commands)) {
            expect(command.template).toEqual(expect.any(String))
            expect(command.template).not.toBe("")
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
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true }, { balanced: {}, smart: {}, spy: {} })
        const targets = Object.entries(commands)
            .flatMap(([commandName, command]) => "agent" in command && typeof command.agent === "string" ? [[commandName, command.agent] as const] : [])

        expect(targets).toHaveLength(14)
        expect(Object.fromEntries(targets)).toEqual({
            "job-concepts": "design",
            "autocode-install": "execute-os",
            author: "execute-author",
            docs: "execute-document",
            explain: "query-code",
            "git-conflict": "assist-git-conflict",
            init: "execute-document",
            learn: "learn-memory",
            "learn-conventions": "learn-memory",
            "learn-code": "learn-memory",
            "learn-env": "learn-memory",
            "learn-prd": "learn-memory",
            "learn-ux": "learn-memory",
            tests: "auto-test",
        })
        expect(targets.some(([, agentId]) => agentId === "memory")).toBe(false)
        expect(agents.memory).toBeUndefined()
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

    test("registers docs and init alongside five direct memory maintenance commands", () => {
        for (const commandName of ["docs", "init"] as const) {
            expect(commands[commandName]).toMatchObject({
                agent: "execute-document",
                subtask: false,
                template: docsCommandTemplate,
            })
        }

        const domains = {
            "learn-conventions": "naming conventions, acronyms, and terms",
            "learn-code": "architecture, technology, models, APIs, errors, security, integrations, and risks",
            "learn-env": "known project and environment context",
            "learn-prd": "product requirements, roles, constraints, and success criteria",
            "learn-ux": "UX flows, navigation, styling, and interactions",
        }
        expect(new Set(Object.values(domains)).size).toBe(5)
        expect(new Set(Object.keys(domains).map((commandName) => commands[commandName]?.template)).size).toBe(5)
        for (const [commandName, domain] of Object.entries(domains)) {
            expect(commands[commandName.replace("learn-", "docs-")]).toBeUndefined()
            expect(commands[commandName]).toMatchObject({
                agent: "learn-memory",
                subtask: false,
                template: docsSubagentCommandTemplate(domain),
            })
            const template = commands[commandName]?.template ?? ""
            expect(template).toContain(`Perform maintenance directly on active project memory for ${domain}, using the request below to scope the work:\n\n<advise>\n$ARGUMENTS\n</advise>`)
            expect(template).not.toMatch(/\bdelegat(?:e|es|ed|ing|ion)\b/i)
            expect(template).not.toMatch(/\bprompt\b/i)
            expect(template).toContain("Add missing facts and prune outdated facts only when supported by evidence; otherwise report uncertainty")
            expect(template).toContain("Record only verified, relevant facts")
            expect(template).toContain("Research narrowly only when critical information is missing or needs verification; do not scan the full project by default")
            expect(template).toContain("Exclude secrets, credentials, transient progress, and legacy data")
            expect(template).toContain("Do not edit skills or external/user skill folders")
            expect(template).toContain("Preserve concurrent memory changes and avoid overwriting other work")
            expect(template).toContain("Report exact updated paths or no change")
            expect(template).toContain("If maintenance fails, report it as pending, not successful")
        }
    })

    test("does not register removed commands", () => {
        for (const commandName of ["commit", "resume"]) {
            expect(commands[commandName]).toBeUndefined()
        }
    })

    test("delegates one learn request with relevant context and safe failure reporting", () => {
        expect(commands.learn).toEqual({ ...learnCommand, agent: "learn-memory" })
        expect(commands.learn?.subtask).toBe(false)
        const template = commands.learn?.template ?? ""
        expect(template).toContain("If <user-guidance> block is empty: Gather corrections, research results, overall feature design decisions, user requirements, project insights")
        expect(template).toContain("Honor explicit remember requests")
        expect(template).toContain("$ARGUMENTS")
        expect(template).toContain("Exclude secrets, credentials, and transient progress")
        expect(template).not.toContain("`subagent` `memory`")
        expect(template).toContain("<user-guidance>\n$ARGUMENTS\n</user-guidance>")
    })

    test("keeps retired memory tools out of the runtime registry", () => {
        const tools = createTools({} as OpencodeClient)

        expect(tools.learn).toBeUndefined()
        expect(Object.keys(tools).filter((name) => name.startsWith("autocode_memory_"))).toEqual([])
        expect(tools.skill).toBeDefined()
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
