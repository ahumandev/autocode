import { describe, expect, test } from "bun:test"
import { applyExternalDirectoryPolicy, applySandboxPlatformPolicy, buildAgents, getAgentPermission, type AutocodeAgentConfig } from "./index"
import { executeOpencodePrompt } from "./prompts/execute_opencode"
import { queryAutocodePrompt } from "./prompts/query-autocode"
import { teachPrompt } from "./prompts/teach"

function permissionRule(permission: AutocodeAgentConfig["permission"], key: string): unknown {
    if (!permission || typeof permission === "string") return undefined
    return (permission as Record<string, unknown>)[key]
}

function resolvePermissionRule(rules: Record<string, unknown>, name: string): unknown {
    if (name in rules) return rules[name]
    const wildcard = Object.entries(rules).find(([pattern]) => pattern !== "*" && pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1)))
    return wildcard?.[1] ?? rules["*"]
}

const sandboxToolNames = ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy"]
const executeRestToolNames = ["autocode_rest"]
const executeOpencodeAllowedPermissionKeys = ["autocode_config_*", "autocode_md_*"]
const executeOpencodeForbiddenToolKeys = ["apply_patch", "bash", "execute", "patch", "task", "write"]
const executeOpencodeAllowedSkillNames = ["author-agent", "author-command", "customize-opencode", "skill-write", "author-rules"]
const queryAutocodeAllowedPermissionKeys = ["autocode_config_read", "autocode_md_read", "autocode_md_frontmatter_read", "webfetch", "websearch*"]
const queryAutocodeForbiddenWritePermissionKeys = ["apply_patch", "bash", "edit", "execute", "patch", "task", "task_external", "write"]
const queryAutocodeAllowedSkillNames = ["author-agent", "author-command", "skill-write"]
const managedAgentTiers = {
    compaction: "context",
    title: "cheap",
    assist: "balanced",
    teach: "balanced",
    auto: "smart",
    design: "balanced",
    edit: "balanced",
    research: "balanced",
    assist_browser: "operator",
    assist_git_conflict: "balanced",
    auto_design: "smart",
    auto_feature: "smart",
    auto_general: "balanced",
    auto_refactor: "smart",
    auto_research: "smart",
    auto_review_api: "smart",
    auto_review_ui: "smart",
    auto_test: "balanced",
    auto_troubleshoot: "smart",
    document_agents: "balanced",
    document_conventions: "balanced",
    document_code: "balanced",
    document_env: "balanced",
    document_install: "balanced",
    document_prd: "balanced",
    document_ux: "balanced",
    execute_author: "balanced",
    execute_code: "balanced",
    execute_debug: "balanced",
    execute_document: "balanced",
    execute_os: "balanced",
    execute_script: "balanced",
    execute_ssh: "balanced",
    execute_config: "operator",
    execute_excel: "operator",
    execute_opencode: "operator",
    execute_rest: "operator",
    execute_sandbox: "operator",
    query_autocode: "fast",
    query_browser: "fast",
    query_config: "fast",
    query_git: "fast",
    query_os: "fast",
    query_skills: "fast",
    query_ssh: "fast",
    query_code: "context",
    query_db: "context",
    query_excel: "context",
    query_text: "context",
    query_web: "context",
} as const

describe("agent policies", () => {
    test("applies external-directory rules to external_directory and task_external permissions", () => {
        const agents = applyExternalDirectoryPolicy({
            ask_capable: {
                permission: {
                    external_directory: "ask",
                    question: "allow",
                    task_external: "ask",
                },
            },
            ask_not_capable: {
                permission: {
                    external_directory: "allow",
                    task_external: "allow",
                },
            },
        }, {
            "/allowed/*": "allow",
            "/review/*": "ask",
            "/blocked/*": "deny",
        })

        expect(permissionRule(agents.ask_capable?.permission, "external_directory")).toEqual({
            "*": "ask",
            "/allowed/*": "allow",
            "/review/*": "ask",
            "/blocked/*": "deny",
        })
        expect(permissionRule(agents.ask_capable?.permission, "task_external")).toEqual({
            "*": "ask",
            "/allowed/*": "allow",
            "/review/*": "ask",
            "/blocked/*": "deny",
        })
        expect(permissionRule(agents.ask_not_capable?.permission, "external_directory")).toEqual({
            "*": "allow",
            "/allowed/*": "allow",
            "/review/*": "deny",
            "/blocked/*": "deny",
        })
    })

    test("denies sandbox tools on unsupported sandbox platforms", () => {
        const agents = applySandboxPlatformPolicy({
            execute_sandbox: {
                permission: {
                    autocode_sandbox_cli: "allow",
                },
            },
            wildcard_sandbox: {
                permission: {
                    "autocode_sandbox_*": "allow",
                },
            },
            string_permission: {
                permission: "allow",
            },
            unrelated: {
                permission: {
                    read: "allow",
                },
            },
        }, "darwin")

        expect(agents.execute_sandbox?.disable).toBe(true)
        for (const toolName of sandboxToolNames) {
            expect(permissionRule(agents.execute_sandbox?.permission, toolName)).toBe("deny")
        }
        expect(permissionRule(agents.wildcard_sandbox?.permission, "autocode_sandbox_cli")).toBe("deny")
        expect(permissionRule(agents.string_permission?.permission, "autocode_sandbox_create")).toBe("deny")
        expect(permissionRule(agents.unrelated?.permission, "autocode_sandbox_cli")).toBeUndefined()
    })

    test("keeps sandbox permissions unchanged on supported sandbox platforms", () => {
        const agents = applySandboxPlatformPolicy({
            execute_sandbox: {
                permission: {
                    autocode_sandbox_cli: "allow",
                },
            },
            wildcard_sandbox: {
                permission: {
                    "autocode_sandbox_*": "allow",
                },
            },
        }, { platform: "linux", env: {}, bwrapUsable: true })

        expect(agents.execute_sandbox?.disable).toBeUndefined()
        expect(permissionRule(agents.execute_sandbox?.permission, "autocode_sandbox_cli")).toBe("allow")
        expect(permissionRule(agents.wildcard_sandbox?.permission, "autocode_sandbox_*")).toBe("allow")
    })

    test("execute_sandbox allows native sandbox file tools", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })

        for (const toolName of ["autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read"]) {
            expect(permissionRule(agents.execute_sandbox?.permission, toolName)).toBe("allow")
        }
        expect(permissionRule(agents.execute_sandbox?.permission, "autocode_sandbox_copy")).toEqual({ sandbox_target: "allow", local_target: "allow" })
    })

    test("buildAgents returns policy-applied definitions with current internal tier metadata", () => {
        const agents = buildAgents({
            "/configured/*": "allow",
        }, { platform: "linux", env: {}, bwrapUsable: true })

        expect(agents.assist?.mode).toBe("primary")
        expect(agents.auto?.mode).toBe("primary")
        expect(agents.execute_sandbox?.mode).toBe("subagent")
        expect(permissionRule(agents.design?.permission, "external_directory")).toEqual(expect.objectContaining({
            "*": "ask",
            "/configured/*": "allow",
        }))
        expect(permissionRule(agents.assist?.permission, "external_directory")).toEqual(expect.objectContaining({
            "*": "ask",
            "/configured/*": "allow",
        }))
        expect(agents.auto?.tier).toBe("smart")
        expect(agents.assist?.tier).toBe("balanced")
        expect(permissionRule(agents.assist?.permission, "autocode_dependencies")).toBe("allow")
        expect(permissionRule(agents.execute_document?.permission, "autocode_dependencies")).toBeUndefined()
    })

    test("allows every primary agent to restart the current session", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })

        for (const agentName of ["assist", "teach", "auto", "design", "edit", "research"] as const) {
            expect(agents[agentName]?.mode).toBe("primary")
            expect(permissionRule(agents[agentName]?.permission, "autocode_session_restart")).toBe("allow")
        }
    })

    test("buildAgents exposes teach as manual-only primary with deny-first research delegation", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })
        const permission = agents.teach?.permission
        const taskPermission = permissionRule(permission, "task") as Record<string, unknown>
        const skillPermission = permissionRule(permission, "skill") as Record<string, unknown>

        expect(agents.teach?.hidden).toBe(false)
        expect(agents.teach?.mode).toBe("primary")
        expect(agents.teach?.tier).toBe("balanced")
        expect(agents.teach?.prompt).toBe(teachPrompt)
        expect(permissionRule(permission, "*")).toBe("deny")
        expect(taskPermission).toEqual({
            "*": "deny",
            "query*": "allow",
            auto_research: "allow",
        })
        for (const agentName of ["query_code", "query_autocode", "auto_research"]) {
            expect(resolvePermissionRule(taskPermission, agentName)).toBe("allow")
        }
        for (const agentName of ["inquiry_code", "research", "auto_researcher", "execute_code", "execute_*"]) {
            expect(resolvePermissionRule(taskPermission, agentName)).toBe("deny")
        }
        for (const toolName of [
            "autocode_job_execute",
            "autocode_agent_execute",
            "write",
            "edit",
            "bash",
            "apply_patch",
            "autocode_agent_swap",
        ]) {
            expect(resolvePermissionRule(permission as Record<string, unknown>, toolName)).toBe("deny")
        }
        for (const capability of ["question", "todo*", "task_resume", "autocode_session_restart", "skill_learn"]) {
            expect(permissionRule(permission, capability)).toBe("allow")
        }
        expect(skillPermission["learned-permissions*"]).toBe("allow")
    })

    test("getAgentPermission restricts direct auto execution to assist and auto", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })
        const teachPermission = getAgentPermission("teach")
        const assistTaskPermission = permissionRule(getAgentPermission("assist"), "task") as Record<string, unknown>
        const autoTaskPermission = permissionRule(getAgentPermission("auto"), "task") as Record<string, unknown>

        for (const toolName of ["autocode_job_execute", "autocode_agent_execute", "write", "edit", "bash", "apply_patch"]) {
            expect(resolvePermissionRule(teachPermission as Record<string, unknown>, toolName)).toBe("deny")
        }
        expect(resolvePermissionRule(assistTaskPermission, "assist_browser")).toBe("allow")
        expect(resolvePermissionRule(autoTaskPermission, "auto_feature")).toBe("allow")
        for (const [agentName, agent] of Object.entries(agents)) {
            if (agentName === "assist" || agentName === "auto") continue
            if (agent.permission === undefined) continue
            const taskPermission = permissionRule(agent.permission, "task")
            const taskRules = typeof taskPermission === "object" && taskPermission !== null
                ? taskPermission as Record<string, unknown>
                : { "*": permissionRule(agent.permission, "*") }

            expect(resolvePermissionRule(taskRules, "assist_browser")).toBe("deny")
            expect(resolvePermissionRule(taskRules, "auto_feature")).toBe("deny")
        }
    })

    test("buildAgents exposes execute_rest as REST-only worker and allows supported orchestration tasks to call it", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })

        expect(agents.execute_rest?.mode).toBe("subagent")
        expect(agents.execute_rest?.hidden).toBe(true)
        expect(agents.execute_rest?.tier).toBe("operator")
        expect(agents.execute_rest?.temperature).toBe(0.1)
        expect(permissionRule(agents.execute_rest?.permission, "*")).toBe("deny")
        for (const toolName of executeRestToolNames) {
            expect(permissionRule(agents.execute_rest?.permission, toolName)).toBe("allow")
        }
        expect(permissionRule(agents.execute_rest?.permission, "doom_loop")).toBeUndefined()
        expect(agents.execute_rest?.prompt).toContain("autocode_rest")
        expect(agents.execute_rest?.prompt).toContain("GET, POST, PUT, PATCH, DELETE")
        expect(agents.execute_rest?.prompt).toContain("response_id")
        expect(agents.execute_rest?.prompt).toContain("Never dump full raw REST result unless user specifically asks")
        expect(agents.execute_rest?.prompt).toContain("Caveman English")
        expect(agents.execute_rest?.prompt).toContain("ask user confirmation")
        expect(agents.execute_rest?.prompt).toContain("Do not leak sensitive headers or body unless user explicitly requested")
        expect(permissionRule(agents.auto_review_api?.permission, "task")).toEqual(expect.objectContaining({
            execute_rest: "allow",
        }))
    })

    test("buildAgents exposes query_autocode as read-only query worker", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })
        const permission = agents.query_autocode?.permission
        const skillPermission = permissionRule(permission, "skill") as Record<string, unknown>

        expect(agents.query_autocode?.hidden).toBe(true)
        expect(agents.query_autocode?.mode).toBe("subagent")
        expect(agents.query_autocode?.prompt).toBe(queryAutocodePrompt)
        expect(permissionRule(permission, "*")).toBe("deny")
        expect(permissionRule(permission, "doom_loop")).toBeUndefined()
        for (const key of queryAutocodeAllowedPermissionKeys) {
            expect(permissionRule(permission, key)).toBe("allow")
        }
        for (const key of queryAutocodeForbiddenWritePermissionKeys) {
            expect(permissionRule(permission, key)).not.toBe("allow")
        }
        expect(skillPermission["*"]).toBe("deny")
        expect(skillPermission["author*"]).not.toBe("allow")
        expect(Object.entries(skillPermission)
            .filter(([, value]) => value === "allow")
            .map(([key]) => key)
            .sort()).toEqual([...queryAutocodeAllowedSkillNames].sort())
    })

    test("buildAgents exposes execute_opencode as scoped OpenCode authoring worker", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })
        const permission = agents.execute_opencode?.permission
        const skillPermission = permissionRule(permission, "skill") as Record<string, unknown>

        expect(Object.keys(agents)).toContain("execute_opencode")
        expect(agents.execute_opencode).toBeDefined()
        expect(agents.execute_opencode?.mode).toBe("subagent")
        expect(agents.execute_opencode?.prompt).toBe(executeOpencodePrompt)
        expect(permissionRule(permission, "*")).toBe("deny")
        for (const key of executeOpencodeAllowedPermissionKeys) {
            expect(permissionRule(permission, key)).toBe("allow")
        }
        for (const key of executeOpencodeForbiddenToolKeys) {
            expect(permissionRule(permission, key)).not.toBe("allow")
        }
        expect(skillPermission["*"]).toBe("deny")
        expect(Object.entries(skillPermission)
            .filter(([, value]) => value === "allow")
            .map(([key]) => key)
            .sort()).toEqual([...executeOpencodeAllowedSkillNames].sort())
    })

    test("execute_opencode prompt stays scoped to OpenCode Markdown artifacts", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })
        const prompt = String(agents.execute_opencode?.prompt ?? "")

        for (const path of [
            "~/.config/opencode/agents/{name}.md",
            ".opencode/agents/{name}.md",
            "~/.config/opencode/commands/{name}.md",
            ".opencode/commands/{name}.md",
            "~/.config/opencode/skills/{name}/SKILL.md",
            ".opencode/skills/{name}/SKILL.md",
        ]) {
            expect(prompt).toContain(path)
        }
        expect(prompt).toContain("Use lowercase kebab-case names")
        expect(prompt).toContain("Reject unsafe path traversal")
        expect(prompt).toContain("Verify the target path is within the allowed roots before any edit")
        expect(prompt).toContain("Make minimal targeted edits")
        expect(prompt).toContain("You MUST NOT edit source code, scripts, package/config files, or Markdown outside the allowed paths")
    })

    test("buildAgents assigns every managed agent its current tier", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })

        for (const [agentName, tier] of Object.entries(managedAgentTiers)) {
            expect((agents as Record<string, { tier?: string }>)[agentName]?.tier).toBe(tier)
        }
    })

    test("execute_rest prompt covers main tool and follow-up saved-response tools", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })
        const prompt = String(agents.execute_rest?.prompt ?? "")

        expect(prompt).toContain("Use `autocode_rest` for GET, POST, PUT, PATCH, DELETE")
        expect(prompt).not.toContain("`query`")
        expect(prompt).not.toContain("rest_key")
    })

    test("execute_author and query_skills prompt learned skill loading guidance is current", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })
        const prompts = [String(agents.execute_author?.prompt ?? ""), String(agents.query_skills?.prompt ?? "")]

        for (const prompt of prompts) {
            expect(prompt).toContain("skill")
            expect(prompt).toContain("learned skills")
            expect(prompt).toContain("repeated recall")
            expect(prompt).not.toContain("native OpenCode")
            expect(prompt).not.toContain("duplicate-load")
            expect(prompt).not.toContain("already tracks")
            expect(prompt).not.toContain("tracks duplicate")
        }
    })
})
