import { describe, expect, test } from "bun:test"
import { resolveOpenCodePaths } from "../../utils/paths"
import { createPlatformCapabilities } from "../../utils/platform"
import { createCommands } from "../../commands"
import { queryAutocodePrompt } from "./query_autocode"

const runtimePaths = resolveOpenCodePaths()

const requiredAgentKeys = [
    "assist",
    "auto",
    "design",
    "advise",
]

const requiredLookupRules = [
    "Research online MCP server compatibility/config when MCP server behavior/config not fully covered by prompt docs.",
    "Scan OpenCode GitHub/source for OpenCode internals.",
    "Scan Autocode GitHub/source for Autocode internals.",
    "Scan other MCP/plugin GitHub sources when answer remains unknown.",
    "Prefer source-backed answers and say when source is unknown.",
]

function expectPromptContainsAll(values: string[]): void {
    for (const value of values) {
        expect(queryAutocodePrompt).toContain(value)
    }
}

describe("queryAutocodePrompt", () => {

    test("uses resolver paths without trailing slashes", () => {
        for (const path of [runtimePaths.globalAgentsRoot, runtimePaths.globalCommandsRoot, runtimePaths.generatedSkillsRoot]) {
            expect(path).not.toMatch(/[\\/]$/)
            expect(queryAutocodePrompt).toContain(path)
        }
    })

    test("accepts custom user markdown review paths as read-only advice sources", () => {
        expectPromptContainsAll([
            "You may read custom user markdown/config files for review and advice only.",
            "You may read user/project agent md, command md, skill md, and rules/instructions via AGENTS.md.",
            `Agent markdown: ${runtimePaths.globalAgentsRoot} and .opencode/agents/`,
            `Command markdown: ${runtimePaths.globalCommandsRoot} and .opencode/commands/`,
            `Skill markdown: ${runtimePaths.generatedSkillsRoot} and .opencode/skills/`,
            "Rules/instructions: AGENTS.md",
        ])
    })

    test("requires advisory output with exact paths and manual snippets", () => {
        expectPromptContainsAll([
            "Output improvements as advice only, with exact file paths and proposed snippets or patch-like snippets for user to apply manually.",
            "Do not output full replacement files unless user explicitly asks; prefer relevant paths and snippets.",
            "advice only",
            "exact file paths",
            "proposed snippets or patch-like snippets",
            "user to apply manually",
            "prefer relevant paths and snippets",
        ])
    })

    test("requires exact authoring skills for advice", () => {
        expectPromptContainsAll([
            "Use exact authoring skills for advice: skill-write for skills, author-agent for agents, author-command for commands.",
            "skill-write for skills",
            "author-agent for agents",
            "author-command for commands",
        ])
    })

    test("forbids producing config changes on disk", () => {
        expectPromptContainsAll([
            "Stay strictly read-only.",
            "Never write, modify, patch, format, generate config files on disk, create files, implement config changes, or claim you changed config.",
            "Never execute code, run tests, or start processes.",
        ])
    })

    test("documents memory configuration and path precedence", () => {
        expectPromptContainsAll([
            `Global config: ${runtimePaths.globalAutocodeConfigPath}`,
            "Worktree/project config: .opencode/autocode.jsonc",
            "autocode.memory.directory",
            '"autocode": {\n    "memory": { "directory": ".opencode/memory" }\n  }',
            "Default directory: .opencode/autocode/memory.",
            "Relative paths resolve from the active project directory, not the config file; absolute paths are supported.",
            "Memory index: INDEX.md inside that directory.",
            "global opencode config, global autocode.jsonc, local opencode configs, local autocode.jsonc configs",
            "Local configs are applied from worktree toward active project directory; last valid nonblank directory wins.",
            "opencode.jsonc takes precedence over opencode.json",
        ])
    })

    test("includes every agent key", () => {
        expectPromptContainsAll(requiredAgentKeys)
    })

    test("documents registered slash commands without retired commands", () => {
        const commands = createCommands(createPlatformCapabilities("linux"), true, true)
        const section = queryAutocodePrompt.split("## Slash commands\n")[1]?.split("\n## Links")[0] ?? ""
        const documented = [...section.matchAll(/^- ([\w-]+):/gm)].map((match) => match[1]).sort()

        expect(documented).toEqual(Object.keys(commands).sort())
    })

    test("lists current documentation and memory commands without retired domain aliases", () => {
        const commands = createCommands(createPlatformCapabilities("linux"))
        expect(queryAutocodePrompt).toContain("- docs: document verified project facts and recent changes.")
        expect(queryAutocodePrompt).toContain("- init: alias for docs; document verified project facts and recent changes.")
        expect(queryAutocodePrompt).toContain("- learn: maintain memory from recent discussion or user guidance.")
        for (const domain of ["conventions", "code", "env", "prd", "ux"]) {
            expect(commands[`learn-${domain}`]?.agent).toBe("learn-memory")
            expect(commands[`docs-${domain}`]).toBeUndefined()
            expect(queryAutocodePrompt).toContain(`- learn-${domain}:`)
            expect(queryAutocodePrompt).not.toContain(`- docs-${domain}:`)
        }
    })

    test("includes lookup behavior rules", () => {
        expectPromptContainsAll(requiredLookupRules)
    })
})
