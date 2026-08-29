import { describe, expect, test } from "bun:test"
import { applyExternalDirectoryPolicy, applySandboxPlatformPolicy, buildAgents, getAgentPermission, type AutocodeAgentConfig } from "./index"
import { executeOpencodePrompt } from "./prompts/execute_opencode"
import { buildExecuteOsPrompt } from "./prompts/execute_os"
import { queryAutocodePrompt } from "./prompts/query_autocode"
import { queryOsPrompt } from "./prompts/query_os"
import { queryYoutubePrompt } from "./prompts/query_youtube"
import { advisePrompt } from "./prompts/advise"
import { createPlatformCapabilities } from "../utils/platform"

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
const executeScriptSandboxToolNames = ["autocode_sandbox_cli", "autocode_sandbox_config_edit", "autocode_sandbox_config_read", "autocode_sandbox_config_remove", "autocode_sandbox_copy", "autocode_sandbox_create", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read"]
const primaryAgents = ["assist", "advise", "auto", "design"] as const
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
    advise: "balanced",
    auto: "smart",
    design: "balanced",
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
    query_youtube: "context",
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
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })

        for (const toolName of ["autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read"]) {
            expect(permissionRule(agents.execute_sandbox?.permission, toolName)).toBe("allow")
        }
        expect(permissionRule(agents.execute_sandbox?.permission, "autocode_sandbox_copy")).toEqual({ sandbox_target: "allow", local_target: "allow" })
    })

    test("buildAgents returns policy-applied definitions with current internal tier metadata", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {
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
        expect(permissionRule(agents.execute_document?.permission, "autocode_dependencies")).toBeUndefined()
    })

    test("document_env allows skill_edit without broader permission grants", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
        const permission = agents.document_env?.permission

        expect(permissionRule(permission, "skill_edit")).toBe("allow")
        expect(permissionRule(permission, "external_directory")).toEqual({ "*": "deny" })
    })

    test("buildAgents registers capability-aware OS prompts", () => {
        for (const [capabilities, wrongShellGuidance] of [
            [createPlatformCapabilities("linux"), /running on windows/i],
            [createPlatformCapabilities("win32", {}), /always use the `bash` tool/i],
            [createPlatformCapabilities("win32", { PSModulePath: "present" }), /`cmd\.exe`/i],
        ] as const) {
            const agents = buildAgents(capabilities)

            expect(agents.execute_os?.prompt).toBe(buildExecuteOsPrompt(capabilities))
            expect(agents.query_os?.prompt).toBe(queryOsPrompt(capabilities))
            expect(agents.execute_os?.prompt).toBeTruthy()
            expect(agents.query_os?.prompt).toBeTruthy()
            expect(agents.execute_os?.prompt).not.toMatch(wrongShellGuidance)
            expect(agents.query_os?.prompt).not.toMatch(wrongShellGuidance)

            if (capabilities.isWindows) {
                expect(agents.execute_sandbox).toBeUndefined()
            }
        }

        const sandboxAgents = buildAgents(createPlatformCapabilities("linux"))
        expect(sandboxAgents.execute_sandbox?.prompt).toBe(buildExecuteOsPrompt({ isWindows: false, commandEnvironment: "linux" }))
        expect(sandboxAgents.execute_sandbox?.prompt).not.toMatch(/running on windows|cmd\.exe|powershell/i)
    })

    test("buildAgents removes sandbox agents, permissions, tasks, and guidance on Windows", () => {
        const agents = buildAgents(createPlatformCapabilities("win32"))

        expect(agents.execute_sandbox).toBeUndefined()
        for (const agent of Object.values(agents)) {
            for (const toolName of sandboxToolNames) {
                expect(permissionRule(agent.permission, toolName)).toBeUndefined()
            }

            const taskPermission = permissionRule(agent.permission, "task")
            const taskRules = typeof taskPermission === "object" && taskPermission !== null ? taskPermission as Record<string, unknown> : undefined
            expect(taskRules?.execute_sandbox).toBeUndefined()
            expect(`${agent.description ?? ""}\n${agent.prompt ?? ""}`).not.toContain("execute_sandbox")
            expect(`${agent.description ?? ""}\n${agent.prompt ?? ""}`).not.toContain("autocode_sandbox")
        }

        for (const agentName of ["auto_review_api", "auto_review_ui", "auto_troubleshoot", "execute_script", "assist"] as const) {
            expect(agents[agentName]).toBeDefined()
            expect(permissionRule(agents[agentName]?.permission, "task")).not.toEqual(expect.objectContaining({ execute_sandbox: "allow" }))
        }
    })

    test("buildAgents keeps sandbox registrations and guidance on Linux", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })

        expect(agents.execute_sandbox).toBeDefined()
        for (const toolName of ["autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read"]) {
            expect(permissionRule(agents.execute_sandbox?.permission, toolName)).toBe("allow")
        }
        expect(permissionRule(agents.execute_sandbox?.permission, "autocode_sandbox_copy")).toEqual({ sandbox_target: "allow", local_target: "allow" })
        for (const agentName of ["auto_review_api", "auto_review_ui", "auto_troubleshoot"] as const) {
            expect(permissionRule(agents[agentName]?.permission, "task")).toEqual(expect.objectContaining({ execute_sandbox: "allow" }))
        }
        expect(agents.execute_sandbox?.description).toContain("execute_sandbox")
        expect(agents.assist?.prompt).toContain("sandbox")
        expect(agents.auto_troubleshoot?.prompt).toContain("sandbox")
    })

    test("allows only primary agents to create sessions", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })

        for (const agentName of ["assist", "advise", "auto", "design"] as const) {
            expect(agents[agentName]?.mode).toBe("primary")
            expect(permissionRule(agents[agentName]?.permission, "autocode_session_create")).toBe("allow")
        }
        for (const [agentName, agent] of Object.entries(agents)) {
            if (primaryAgents.includes(agentName as typeof primaryAgents[number])) continue
            expect(permissionRule(agent.permission, "autocode_session_create")).toBeUndefined()
        }
    })

    test("buildAgents exposes advise as research and manual-guidance primary", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
        const permission = agents.advise?.permission
        const taskPermission = permissionRule(permission, "task") as Record<string, unknown>
        const skillPermission = permissionRule(permission, "skill") as Record<string, unknown>

        expect(agents.advise?.hidden).toBe(false)
        expect(agents.advise?.mode).toBe("primary")
        expect(agents.advise?.tier).toBe("balanced")
        expect(agents.advise?.prompt).toBe(advisePrompt)
        expect(advisePrompt).toContain("Do not ask user to make a project change until solution is clear")
        expect(advisePrompt).toContain("Discover solution before giving implementation steps")
        expect(permissionRule(permission, "*")).toBe("deny")
        expect(taskPermission).toEqual({
            "*": "deny",
            "query*": "allow",
            auto_research: "allow",
        })
        for (const agentName of ["query_code", "query_autocode", "auto_research"]) {
            expect(resolvePermissionRule(taskPermission, agentName)).toBe("allow")
        }
        for (const agentName of ["inquiry_code", "auto_researcher", "execute_code", "execute_*"]) {
            expect(resolvePermissionRule(taskPermission, agentName)).toBe("deny")
        }
        for (const toolName of [
            "autocode_job_execute",
            "autocode_agent_execute",
            "write",
            "edit",
            "bash",
            "apply_patch",
        ]) {
            expect(resolvePermissionRule(permission as Record<string, unknown>, toolName)).toBe("deny")
        }
        for (const capability of ["question", "todo*", "task_resume", "autocode_session_create"]) {
            expect(permissionRule(permission, capability)).toBe("allow")
        }
        expect(permissionRule(permission, "task_external")).toBeUndefined()
        expect(permissionRule(permission, "external_directory")).toEqual({ "*": "deny" })
        expect(permissionRule(permission, "skill_learn")).toBe("allow")
        expect(skillPermission["learned-permissions*"]).toBe("allow")
        expect(skillPermission["skill-write"]).toBe("allow")
    })

    test("getAgentPermission restricts direct auto execution to assist and auto", () => {
        const capabilities = createPlatformCapabilities("linux")
        const agents = buildAgents(capabilities, {}, { platform: "linux", env: {}, bwrapUsable: true })
        const advisePermission = getAgentPermission("advise", capabilities)
        const assistTaskPermission = permissionRule(getAgentPermission("assist", capabilities), "task") as Record<string, unknown>
        const autoTaskPermission = permissionRule(getAgentPermission("auto", capabilities), "task") as Record<string, unknown>

        for (const toolName of ["autocode_job_execute", "autocode_agent_execute", "write", "edit", "bash", "apply_patch"]) {
            expect(resolvePermissionRule(advisePermission as Record<string, unknown>, toolName)).toBe("deny")
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
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })

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

    test("execute_script permits only managed script workflow tools", () => {
        const permission = getAgentPermission("execute_script", createPlatformCapabilities("linux"))
        const rules = permission as Record<string, unknown>

        expect(permissionRule(permission, "*")).toBe("deny")
        expect(Object.entries(rules)
            .filter(([, action]) => action === "allow")
            .map(([toolName]) => toolName)
            .sort()).toEqual([
                "autocode_script_install",
                "autocode_script_project",
                "autocode_script_run",
                "autocode_script_service",
                "edit",
                "glob",
                "grep",
                "read",
                "skill_learn",
                "write",
            ])
        for (const toolName of [
            "read",
            "write",
            "edit",
            "glob",
            "grep",
            "autocode_script_project",
            "autocode_script_install",
            "autocode_script_run",
            "autocode_script_service",
        ]) {
            expect(resolvePermissionRule(rules, toolName)).toBe("allow")
        }
        for (const toolName of [
            "bash",
            "pty",
            "pty_spawn",
            "pty_exec",
            "pty_write",
            ...executeScriptSandboxToolNames,
            "autocode_kill",
            "autocode_process_kill",
            "task_external",
            "autocode_ssh_command",
            "autocode_dependencies",
            "list",
            "apply_patch",
            "filesystem",
            "config",
            "autocode_config_read",
            "autocode_config_edit",
            "autocode_config_remove",
            "webfetch",
            "skill",
            "todo",
            "todowrite",
            "autocode_script_unknown",
            "unknown_tool",
        ]) {
            const rule = resolvePermissionRule(rules, toolName)
            expect(permissionRule(rule as AutocodeAgentConfig["permission"], "*") ?? rule).toBe("deny")
        }
    })

    test("buildAgents exposes query_autocode as read-only query worker", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
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

    test("buildAgents exposes query_youtube as hidden caption-only worker with timestamp citations", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
        const permission = agents.query_youtube?.permission
        const rules = permission as Record<string, unknown>

        expect(agents.query_youtube?.hidden).toBe(true)
        expect(agents.query_youtube?.mode).toBe("subagent")
        expect(agents.query_youtube?.prompt).toBe(queryYoutubePrompt)
        expect(permissionRule(permission, "*")).toBe("deny")
        expect(Object.keys(rules).sort()).toEqual(["*", "autocode_youtube_transcribe", "external_directory"])
        expect(Object.entries(rules).filter(([, action]) => action === "allow").map(([key]) => key)).toEqual(["autocode_youtube_transcribe"])
        expect(permissionRule(permission, "external_directory")).toEqual({ "*": "deny" })
        for (const toolName of [
            "apply_patch",
            "autocode_audio_transcribe",
            "autocode_file_read",
            "autocode_media_transcribe",
            "autocode_rest",
            "autocode_script_run",
            "bash",
            "context7",
            "context7_resolve-library-id",
            "edit",
            "execute",
            "file",
            "ffmpeg",
            "filesystem",
            "glob",
            "grep",
            "lsp",
            "read",
            "search",
            "webfetch",
            "websearch",
            "websearch_query",
            "whisper",
            "write",
        ]) {
            expect(resolvePermissionRule(rules, toolName)).toBe("deny")
        }
    })

    test("buildAgents exposes execute_opencode as scoped OpenCode authoring worker", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
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
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
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
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })

        for (const [agentName, tier] of Object.entries(managedAgentTiers)) {
            expect((agents as Record<string, { tier?: string }>)[agentName]?.tier).toBe(tier)
        }
    })

    test("execute_rest prompt covers main tool and follow-up saved-response tools", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
        const prompt = String(agents.execute_rest?.prompt ?? "")

        expect(prompt).toContain("Use `autocode_rest` for GET, POST, PUT, PATCH, DELETE")
        expect(prompt).not.toContain("`query`")
        expect(prompt).not.toContain("rest_key")
    })

    test("execute_author and query_skills prompt learned skill loading guidance is current", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
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
