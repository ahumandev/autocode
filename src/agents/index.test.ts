import { describe, expect, test } from "bun:test"
import { applyExternalDirectoryPolicy, applySandboxPlatformPolicy, buildAgents, getAgentPermission, type AutocodeAgentConfig } from "./index"
import { executeOpencodePrompt } from "./prompts/execute_opencode"
import { buildExecuteOsPrompt } from "./prompts/execute_os"
import { queryAutocodePrompt } from "./prompts/query_autocode"
import { queryOsPrompt } from "./prompts/query_os"
import { queryYoutubePrompt } from "./prompts/query_youtube"
import { advisePrompt } from "./prompts/advise"
import { spyPrompt } from "./prompts/spy"
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
const primaryAgents = ["assist", "advise", "auto", "design", "spy"] as const
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
    spy: "spy",
    auto: "smart",
    design: "balanced",
    "assist-browser": "operator",
    assist_git_conflict: "balanced",
    "auto-author": "smart",
    "auto-design": "smart",
    "auto-feature": "smart",
    "auto-general": "balanced",
    "auto-refactor": "smart",
    "auto-research": "smart",
    auto_review_api: "smart",
    auto_review_ui: "smart",
    "auto-test": "balanced",
    "auto-troubleshoot": "smart",
    "document-agents": "balanced",
    "document-conventions": "balanced",
    "document-code": "balanced",
    "document-env": "balanced",
    "document-install": "balanced",
    "document-prd": "balanced",
    "document-ux": "balanced",
    "execute-author": "balanced",
    "execute-code": "balanced",
    "execute-debug": "balanced",
    "execute-document": "balanced",
    "execute-os": "balanced",
    "execute-script": "balanced",
    "execute-ssh": "balanced",
    "execute-config": "operator",
    "execute-excel": "operator",
    "execute-opencode": "operator",
    "execute-rest": "operator",
    "execute-sandbox": "operator",
    "query-autocode": "fast",
    "query-browser": "fast",
    "query-config": "fast",
    "query-git": "fast",
    "query-os": "fast",
    "query-skills": "fast",
    "query-ssh": "fast",
    "query-code": "context",
    "query-db": "context",
    "query-excel": "context",
    "query-text": "context",
    "query-web": "context",
    "query-youtube": "context",
} as const

const legacyAgentIds = [
    "assist_browser", "auto_author", "auto_design", "auto_feature", "auto_general", "auto_refactor", "auto_research", "auto_test", "auto_troubleshoot",
    "document_agents", "document_conventions", "document_code", "document_env", "document_install", "document_prd", "document_ux",
    "execute_author", "execute_code", "execute_config", "execute_debug", "execute_document", "execute_excel", "execute_opencode", "execute_os", "execute_rest", "execute_sandbox", "execute_script", "execute_ssh",
    "query_autocode", "query_browser", "query_code", "query_config", "query_db", "query_excel", "query_git", "query_os", "query_skills", "query_ssh", "query_text", "query_web", "query_youtube",
] as const

const unaffectedAgentIds = ["build", "compaction", "explore", "general", "plan", "title", "advise", "assist", "auto", "design", "spy", "assist_git_conflict", "auto_review_api", "auto_review_ui"] as const

const configuredManagedAgentTiers = { balanced: {}, smart: {}, spy: {} }

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
            "execute-sandbox": {
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

        expect(agents["execute-sandbox"]?.disable).toBe(true)
        for (const toolName of sandboxToolNames) {
            expect(permissionRule(agents["execute-sandbox"]?.permission, toolName)).toBe("deny")
        }
        expect(permissionRule(agents.wildcard_sandbox?.permission, "autocode_sandbox_cli")).toBe("deny")
        expect(permissionRule(agents.string_permission?.permission, "autocode_sandbox_create")).toBe("deny")
        expect(permissionRule(agents.unrelated?.permission, "autocode_sandbox_cli")).toBeUndefined()
    })

    test("keeps sandbox permissions unchanged on supported sandbox platforms", () => {
        const agents = applySandboxPlatformPolicy({
            "execute-sandbox": {
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

        expect(agents["execute-sandbox"]?.disable).toBeUndefined()
        expect(permissionRule(agents["execute-sandbox"]?.permission, "autocode_sandbox_cli")).toBe("allow")
        expect(permissionRule(agents.wildcard_sandbox?.permission, "autocode_sandbox_*")).toBe("allow")
    })

    test("execute-sandbox allows native sandbox file tools", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })

        for (const toolName of ["autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read"]) {
            expect(permissionRule(agents["execute-sandbox"]?.permission, toolName)).toBe("allow")
        }
        expect(permissionRule(agents["execute-sandbox"]?.permission, "autocode_sandbox_copy")).toEqual({ sandbox_target: "allow", local_target: "allow" })
    })

    test("buildAgents returns policy-applied definitions with current internal tier metadata", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {
            "/configured/*": "allow",
        }, { platform: "linux", env: {}, bwrapUsable: true }, [], configuredManagedAgentTiers)

        expect(agents.assist?.mode).toBe("primary")
        expect(agents.auto?.mode).toBe("primary")
        expect(agents["execute-sandbox"]?.mode).toBe("subagent")
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
        expect(permissionRule(agents["execute-document"]?.permission, "autocode_dependencies")).toBeUndefined()
    })

    test("buildAgents registers the exact current agent ID contract", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true }, [], configuredManagedAgentTiers)
        const expectedAgentIds = [
            ...unaffectedAgentIds,
            "assist-browser", "auto-author", "auto-design", "auto-feature", "auto-general", "auto-refactor", "auto-research", "auto-test", "auto-troubleshoot",
            "document-agents", "document-conventions", "document-code", "document-env", "document-install", "document-prd", "document-ux",
            "execute-author", "execute-code", "execute-config", "execute-debug", "execute-document", "execute-excel", "execute-opencode", "execute-os", "execute-rest", "execute-sandbox", "execute-script", "execute-ssh",
            "query-autocode", "query-browser", "query-code", "query-config", "query-db", "query-excel", "query-git", "query-os", "query-skills", "query-ssh", "query-text", "query-web", "query-youtube",
        ]

        expect(Object.keys(agents).sort()).toEqual(expectedAgentIds.sort())
        for (const agentId of legacyAgentIds) expect(agents[agentId]).toBeUndefined()
        for (const agentId of unaffectedAgentIds) expect(agents[agentId]).toBeDefined()
    })

    test("document-env allows skill_edit without broader permission grants", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true }, [], configuredManagedAgentTiers)
        const permission = agents["document-env"]?.permission

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

            expect(agents["execute-os"]?.prompt).toBe(buildExecuteOsPrompt(capabilities))
            expect(agents["query-os"]?.prompt).toBe(queryOsPrompt(capabilities))
            expect(agents["execute-os"]?.prompt).toBeTruthy()
            expect(agents["query-os"]?.prompt).toBeTruthy()
            expect(agents["execute-os"]?.prompt).not.toMatch(wrongShellGuidance)
            expect(agents["query-os"]?.prompt).not.toMatch(wrongShellGuidance)

            if (capabilities.isWindows) {
                expect(agents["execute-sandbox"]).toBeUndefined()
            }
        }

        const sandboxAgents = buildAgents(createPlatformCapabilities("linux"))
        expect(sandboxAgents["execute-sandbox"]?.prompt).toBe(buildExecuteOsPrompt({ isWindows: false, commandEnvironment: "linux" }))
        expect(sandboxAgents["execute-sandbox"]?.prompt).not.toMatch(/running on windows|cmd\.exe|powershell/i)
    })

    test("buildAgents removes sandbox agents, permissions, tasks, and guidance on Windows", () => {
        const agents = buildAgents(createPlatformCapabilities("win32"))

        expect(agents["execute-sandbox"]).toBeUndefined()
        for (const agent of Object.values(agents)) {
            for (const toolName of sandboxToolNames) {
                expect(permissionRule(agent.permission, toolName)).toBeUndefined()
            }

            const taskPermission = permissionRule(agent.permission, "task")
            const taskRules = typeof taskPermission === "object" && taskPermission !== null ? taskPermission as Record<string, unknown> : undefined
            expect(taskRules?.["execute-sandbox"]).toBeUndefined()
            expect(`${agent.description ?? ""}\n${agent.prompt ?? ""}`).not.toContain("execute-sandbox")
            expect(`${agent.description ?? ""}\n${agent.prompt ?? ""}`).not.toContain("autocode_sandbox")
        }

        for (const agentName of ["auto_review_api", "auto_review_ui", "auto-troubleshoot", "execute-script", "assist"] as const) {
            expect(agents[agentName]).toBeDefined()
            expect(permissionRule(agents[agentName]?.permission, "task")).not.toEqual(expect.objectContaining({ "execute-sandbox": "allow" }))
        }
    })

    test("buildAgents keeps sandbox registrations and guidance on Linux", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true }, [], configuredManagedAgentTiers)

        expect(agents["execute-sandbox"]).toBeDefined()
        for (const toolName of ["autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read"]) {
            expect(permissionRule(agents["execute-sandbox"]?.permission, toolName)).toBe("allow")
        }
        expect(permissionRule(agents["execute-sandbox"]?.permission, "autocode_sandbox_copy")).toEqual({ sandbox_target: "allow", local_target: "allow" })
        for (const agentName of ["auto_review_api", "auto_review_ui", "auto-troubleshoot"] as const) {
            expect(permissionRule(agents[agentName]?.permission, "task")).toEqual(expect.objectContaining({ "execute-sandbox": "allow" }))
        }
        expect(agents["execute-sandbox"]?.description).toContain("execute-sandbox")
        expect(agents.assist?.prompt).toContain("sandbox")
        expect(agents["auto-troubleshoot"]?.prompt).toContain("sandbox")
    })

    test("allows only primary agents to create sessions", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true }, [], configuredManagedAgentTiers)

        for (const agentName of ["assist", "advise", "auto", "design", "spy"] as const) {
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
            "auto-research": "allow",
        })
        for (const agentName of ["query-code", "query-autocode", "auto-research"]) {
            expect(resolvePermissionRule(taskPermission, agentName)).toBe("allow")
        }
        for (const agentName of ["inquiry-code", "auto-researcher", "execute-code", "execute-*"]) {
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
		expect(skillPermission["learned-permissions*"]).toBeUndefined()
        expect(skillPermission["skill-write"]).toBe("allow")
    })

    test("buildAgents exposes spy as visible read-only direct-use primary", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true }, [], configuredManagedAgentTiers)
        const spy = agents.spy
        const permission = spy?.permission
        const rules = permission as Record<string, unknown>

        expect(spy?.color).toBe("#0000AA")
        expect(spy?.description).toContain("private information")
        expect(spy?.hidden).toBe(false)
        expect(spy?.mode).toBe("primary")
        expect(spy?.tier).toBe("spy")
        expect(spy?.prompt).toBe(spyPrompt)
        expect(permissionRule(permission, "*")).toBe("deny")
        for (const toolName of ["autocode_config_read", "autocode_md_frontmatter_read", "autocode_md_read", "question", "todo"]) {
            expect(resolvePermissionRule(rules, toolName)).toBe("allow")
        }
        expect(permissionRule(permission, "task")).toBeUndefined()
        expect(permissionRule(permission, "autocode_agent_execute")).toBeUndefined()
        expect(permissionRule(permission, "autocode_session_create")).toBe("allow")
        for (const toolName of ["autocode_agent_execute", "autocode_job_execute", "autocode_ssh_command", "bash", "edit", "execute", "git_commit", "write"]) {
            expect(resolvePermissionRule(rules, toolName)).toBe("deny")
        }
    })

    test("getAgentPermission restricts direct auto execution to assist and auto", () => {
        const capabilities = createPlatformCapabilities("linux")
        const agents = buildAgents(capabilities, {}, { platform: "linux", env: {}, bwrapUsable: true }, [], configuredManagedAgentTiers)
        const advisePermission = getAgentPermission("advise", capabilities)
        const assistTaskPermission = permissionRule(getAgentPermission("assist", capabilities), "task") as Record<string, unknown>
        const autoTaskPermission = permissionRule(agents.auto?.permission, "task") as Record<string, unknown>

        for (const toolName of ["autocode_job_execute", "autocode_agent_execute", "write", "edit", "bash", "apply_patch"]) {
            expect(resolvePermissionRule(advisePermission as Record<string, unknown>, toolName)).toBe("deny")
        }
        expect(resolvePermissionRule(assistTaskPermission, "assist-browser")).toBe("allow")
        expect(resolvePermissionRule(autoTaskPermission, "auto-feature")).toBe("allow")
        for (const [agentName, agent] of Object.entries(agents)) {
            if (agentName === "assist" || agentName === "auto") continue
            if (agent.permission === undefined) continue
            const taskPermission = permissionRule(agent.permission, "task")
            const taskRules = typeof taskPermission === "object" && taskPermission !== null
                ? taskPermission as Record<string, unknown>
                : { "*": "deny" }

            expect(resolvePermissionRule(taskRules, "assist-browser")).toBe("deny")
            expect(resolvePermissionRule(taskRules, "auto-feature")).toBe("deny")
        }
    })

    test("buildAgents exposes execute-rest as REST-only worker and allows supported orchestration tasks to call it", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })

        expect(agents["execute-rest"]?.mode).toBe("subagent")
        expect(agents["execute-rest"]?.hidden).toBe(true)
        expect(agents["execute-rest"]?.tier).toBe("operator")
        expect(agents["execute-rest"]?.temperature).toBe(0.1)
        expect(permissionRule(agents["execute-rest"]?.permission, "*")).toBe("deny")
        for (const toolName of executeRestToolNames) {
            expect(permissionRule(agents["execute-rest"]?.permission, toolName)).toBe("allow")
        }
        expect(permissionRule(agents["execute-rest"]?.permission, "doom_loop")).toBeUndefined()
        expect(agents["execute-rest"]?.prompt).toContain("autocode_rest")
        expect(agents["execute-rest"]?.prompt).toContain("GET, POST, PUT, PATCH, DELETE")
        expect(agents["execute-rest"]?.prompt).toContain("response_id")
        expect(agents["execute-rest"]?.prompt).toContain("Never dump full raw REST result unless user specifically asks")
        expect(agents["execute-rest"]?.prompt).toContain("Caveman English")
        expect(agents["execute-rest"]?.prompt).toContain("ask user confirmation")
        expect(agents["execute-rest"]?.prompt).toContain("Do not leak sensitive headers or body unless user explicitly requested")
        expect(permissionRule(agents.auto_review_api?.permission, "task")).toEqual(expect.objectContaining({
            "execute-rest": "allow",
        }))
    })

    test("execute-script permits only managed script workflow tools", () => {
        const permission = getAgentPermission("execute-script", createPlatformCapabilities("linux"))
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

    test("buildAgents exposes query-autocode as read-only query worker", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
        const permission = agents["query-autocode"]?.permission
        const skillPermission = permissionRule(permission, "skill") as Record<string, unknown>

        expect(agents["query-autocode"]?.hidden).toBe(true)
        expect(agents["query-autocode"]?.mode).toBe("subagent")
        expect(agents["query-autocode"]?.prompt).toBe(queryAutocodePrompt)
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

    test("buildAgents exposes query-youtube as hidden caption-only worker with timestamp citations", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
        const permission = agents["query-youtube"]?.permission
        const rules = permission as Record<string, unknown>

        expect(agents["query-youtube"]?.hidden).toBe(true)
        expect(agents["query-youtube"]?.mode).toBe("subagent")
        expect(agents["query-youtube"]?.prompt).toBe(queryYoutubePrompt)
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

    test("buildAgents exposes execute-opencode as scoped OpenCode authoring worker", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
        const permission = agents["execute-opencode"]?.permission
        const skillPermission = permissionRule(permission, "skill") as Record<string, unknown>

        expect(Object.keys(agents)).toContain("execute-opencode")
        expect(agents["execute-opencode"]).toBeDefined()
        expect(agents["execute-opencode"]?.mode).toBe("subagent")
        expect(agents["execute-opencode"]?.prompt).toBe(executeOpencodePrompt)
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

    test("execute-opencode prompt stays scoped to OpenCode Markdown artifacts", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
        const prompt = String(agents["execute-opencode"]?.prompt ?? "")

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
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true }, [], configuredManagedAgentTiers)

        for (const [agentName, tier] of Object.entries(managedAgentTiers)) {
            expect((agents as Record<string, { tier?: string }>)[agentName]?.tier).toBe(tier)
        }
    })

    test("buildAgents registers spy and auto only for their configured tiers", () => {
        const capabilities = createPlatformCapabilities("linux")
        const build = (tiers: Parameters<typeof buildAgents>[4]) => buildAgents(capabilities, {}, undefined, [], tiers)

        const noTiers = build({})
        expect(noTiers.spy).toBeUndefined()
        expect(noTiers.auto).toBeUndefined()
        expect(noTiers.assist).toBeDefined()

        const balancedOnly = build({ balanced: {} })
        expect(balancedOnly.spy).toBeUndefined()
        expect(balancedOnly.auto).toBeUndefined()

        const spyWithoutModel = build({ spy: {} })
        expect(spyWithoutModel.spy).toBeDefined()
        expect(spyWithoutModel.auto).toBeUndefined()

        const smartOnly = build({ smart: {} })
        expect(smartOnly.spy).toBeUndefined()
        expect(smartOnly.auto).toBeDefined()

        const bothTiers = build({ spy: {}, smart: {} })
        expect(bothTiers.spy).toBeDefined()
        expect(bothTiers.auto).toBeDefined()
    })

    test("execute-rest prompt covers main tool and follow-up saved-response tools", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
        const prompt = String(agents["execute-rest"]?.prompt ?? "")

        expect(prompt).toContain("Use `autocode_rest` for GET, POST, PUT, PATCH, DELETE")
        expect(prompt).not.toContain("`query`")
        expect(prompt).not.toContain("rest_key")
    })

    test("execute-author and query-skills prompt learned skill loading guidance is current", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, { platform: "linux", env: {}, bwrapUsable: true })
        const prompts = [String(agents["execute-author"]?.prompt ?? ""), String(agents["query-skills"]?.prompt ?? "")]

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
