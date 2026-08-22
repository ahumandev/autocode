import { describe, expect, test } from "bun:test"
import { resolveOpenCodePaths } from "../../utils/paths"
import { queryAutocodePrompt } from "./query_autocode"

const runtimePaths = resolveOpenCodePaths()

const requiredAgentKeys = [
    "assist",
    "auto",
    "design",
    "advise",
]

const requiredSlashCommands = [
    "job-concepts",
    "job-design",
    "job-facilitate",
    "job-execute",
    "commit",
    "autocode-install",
    "autocode-version",
    "author-article",
    "docs",
    "docs-conventions",
    "docs-code",
    "docs-env",
    "docs-prd",
    "docs-ux",
    "explain",
    "fix",
    "commit",
    "git-conflict",
    "init",
    "install",
    "advise",
    "plan",
    "refactor",
    "repeat-as-md",
    "repeat-as-wiki",
    "report-last",
    "report-session",
    "resume",
    "tests",
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

    test("includes every agent key", () => {
        expectPromptContainsAll(requiredAgentKeys)
    })

    test("includes every slash command", () => {
        expectPromptContainsAll(requiredSlashCommands)
    })

    test("includes lookup behavior rules", () => {
        expectPromptContainsAll(requiredLookupRules)
    })
})
