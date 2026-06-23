import { describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir, tmpdir } from "os"
import type { Dirent } from "fs"
import type { Config as PluginConfig, Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Session, OpencodeClient, SessionGetData, SessionChildrenData, SessionPromptAsyncData } from "@opencode-ai/sdk"
import autocode from "../plugin"
import { loadAutocodeConfig } from "@/config"
import type { ConfigFileSystem } from "@/config"
import { createAutocodeConceptReadTool } from "./autocode_concept_read"
import { createAutocodeConceptListTool } from "./autocode_concept_list"
import { createAutocodeConceptCreateTool } from "./autocode_concept_create"
import { createTaskResumeTool } from "./task_resume"
import { createAutocodePlanReadTool } from "./autocode_plan_read"
import { composePlanMarkdown, createAutocodePlanSaveTool } from "./autocode_plan_save"
import { createAutocodeLogoFindTool } from "./autocode_logo_find"
import { learnedSkillSubjects } from "./skill_learn"
import { createAbortResponse, createErrorResponse } from "@/utils/tools"
import { applySandboxPlatformPolicy } from "@/agents"
import { createTools } from "./index"
import { createToolContext } from "./test_context"
import type { SandboxPlatformSupportOptions } from "@/utils/sandbox"

const PROMPT_TASK_RESUME = "You have been interrupted, therefore you MUST:\n1. Use `task_resume` tool to resume previous interrupted task sessions\n2. Then resume your own work"
const PROMPT_WORK_RESUME = "Resume"

type PermissionRule = "ask" | "allow" | "deny"
type ExternalDirectoryPermission = PermissionRule | Record<string, PermissionRule>
type RuntimePermissionObject = Record<string, unknown> & {
    external_directory?: ExternalDirectoryPermission
    task?: Record<string, unknown> | string
}
type RuntimePermission = RuntimePermissionObject | string | undefined
type RuntimeAgentConfig = Omit<NonNullable<NonNullable<PluginConfig["agent"]>[string]>, "permission"> & {
    permission?: RuntimePermission
}
type RuntimeConfigPermission = Omit<NonNullable<PluginConfig["permission"]>, "external_directory"> & {
    external_directory?: ExternalDirectoryPermission
}
type ConfigWithRuntimeSections = Omit<PluginConfig, "agent" | "command" | "permission"> & {
    agent: Record<string, RuntimeAgentConfig>
    command: NonNullable<PluginConfig["command"]>
    permission?: RuntimeConfigPermission
}
type PluginInputWithSandboxSupportOverride = PluginInput & {
    sandboxSupportOverride?: SandboxPlatformSupportOptions
}

function getPermissionRule(permission: RuntimePermission, key: string): unknown {
    if (!permission || typeof permission === "string") {
        return undefined
    }

    return permission[key]
}

function getTaskPermissionRule(permission: RuntimePermission, key: string): unknown {
    if (!permission || typeof permission === "string") {
        return undefined
    }

    const task = permission.task
    if (!task || typeof task === "string") {
        return undefined
    }

    return task[key]
}

function getAgentField(cfg: ConfigWithRuntimeSections, agentName: string, key: string): unknown {
    return cfg.agent[agentName]?.[key]
}

async function configurePlugin(plugin: Hooks, cfg: ConfigWithRuntimeSections): Promise<void> {
    await plugin.config?.(cfg as PluginConfig)
}

type MockDirentType = "file" | "directory"
type ReaddirWithFileTypes = (dirPath: string, options: { withFileTypes: true }) => Promise<Dirent[]>

function createDirent(name: string, type: MockDirentType = "directory"): Dirent {
    return {
        name,
        isDirectory: () => type === "directory",
        isFile: () => type === "file",
    } as Dirent
}

function createMissingFileError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function createPluginInput(
    client: OpencodeClient,
    worktree = "/workspace",
    directory?: string,
    sandboxSupportOverride: SandboxPlatformSupportOptions = { platform: "linux", env: {}, bwrapUsable: true },
): PluginInputWithSandboxSupportOverride {
    const dir = directory ?? worktree
    return {
        client,
        project: {
            id: "project-1",
            worktree,
            time: { created: Date.now() },
        },
        directory: dir,
        worktree,
        experimental_workspace: {
            register() {
            },
        },
        serverUrl: new URL("http://localhost:4096"),
        sandboxSupportOverride,
        $: {} as PluginInput["$"],
    }
}

function parseToolResult(result: string | { output: string }) {
    return JSON.parse(typeof result === "string" ? result : result.output)
}

function toolSurfaceText(tool: any) {
    const argDescriptions = Object.values(tool?.args ?? {}).map((arg: any) => arg.description ?? arg.unwrap?.().description ?? arg.def?.innerType?.description ?? "")
    return [tool?.description ?? "", ...argDescriptions].join("\n")
}

function executePlanSave(tool: ReturnType<typeof createAutocodePlanSaveTool>, args: Record<string, string>) {
    return tool.execute(args as never, createToolContext())
}

function createSession(id: string, directory: string, permission?: unknown): Session & { permission?: unknown } {
    return {
        id,
        projectID: "project-1",
        permission,
        directory,
        title: "Session",
        version: "1",
        time: {
            created: Date.now(),
            updated: Date.now(),
        },
    }
}

async function withIsolatedConfigHome<T>(fn: () => Promise<T>): Promise<T> {
    const home = mkdtempSync(join(tmpdir(), "autocode-home-"))
    const oldHome = process.env.HOME
    const oldXdgConfigHome = process.env.XDG_CONFIG_HOME

    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = join(home, ".config")

    try {
        return await fn()
    } finally {
        if (oldHome === undefined) delete process.env.HOME
        else process.env.HOME = oldHome

        if (oldXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = oldXdgConfigHome

        rmSync(home, { recursive: true, force: true })
    }
}

function createResumeMessages(permission?: unknown, toolName = "task") {
    return [
        {
            info: {
                id: "user-1",
                role: "user",
                agent: "pair",
                permission,
                time: {
                    created: 1,
                },
            },
            parts: [],
        },
        {
            info: {
                id: "assistant-1",
                role: "assistant",
                providerID: "provider",
                modelID: "model",
                time: {
                    created: 2,
                },
            },
            parts: [{
                type: "tool",
                tool: toolName,
                messageID: "assistant-1",
                state: {
                    status: "running",
                    time: {
                        start: 3,
                    },
                },
            }],
        },
    ] as Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]
}

function createChildrenForParent(parent: Session, child: Session) {
    return async function children(args: SessionChildrenData) {
        return { data: args.path.id === parent.id ? [child] : [] }
    }
}

function createMockClient(): OpencodeClient {
    return {
        session: {
            async get() {
                return { data: { id: "session-1", projectID: "project-1", directory: "/workspace", title: "Session", version: "1", time: { created: Date.now(), updated: Date.now() } } }
            },
            async children() {
                return { data: [] }
            },
            async messages() {
                return { data: [] }
            },
            async promptAsync() {
                return {}
            },
            async update() {
                return {}
            },
        },
        tui: {
            async showToast() {
                return { data: true }
            },
        },
    } as unknown as OpencodeClient
}

function createConfig(): ConfigWithRuntimeSections {
    return { agent: {}, command: {} }
}

function injectedPromptText(cfg: ConfigWithRuntimeSections) {
    return [
        ...Object.values(cfg.command).map(command => command.template),
        ...Object.values(cfg.agent).map(agent => agent.prompt ?? ""),
    ].join("\n")
}

describe("auto resume wiring", () => {
    test("registers task_resume tool with the injected client and resume command agent", async () => {
        const calls: Array<{ sessionID: string, directory: string }> = []
        const client: OpencodeClient = {
            session: {
                async get(args: SessionGetData) {
                    calls.push({ sessionID: args.path.id, directory: args.query?.directory ?? "" })
                    return {
                        data: createSession(args.path.id, args.query?.directory ?? ""),
                    }
                },
                async children() {
                    return { data: [] }
                },
                async messages() {
                    return { data: [] }
                },
                async promptAsync() {
                    return {}
                },
            },
        } as unknown as OpencodeClient
        const plugin = await autocode(createPluginInput(client))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)
        const result = await plugin.tool?.task_resume.execute({}, createToolContext())

        expect(plugin.tool?.task_resume).toBeDefined()
        expect(result).toBe("No interrupted descendants found.")
        expect(calls).toEqual([{ sessionID: "session-1", directory: "/workspace" }])
        expect(cfg.command.resume?.agent).toBeUndefined() // Very important otherwise it cannot resume with original agent
        expect(cfg.command.resume?.template).toContain("task_resume")
        expect(getPermissionRule(cfg.agent.assist?.permission, "task_resume")).toBe("allow")
    })

    test("registers job-design command for the design agent", async () => {
        const plugin = await autocode(createPluginInput(createMockClient()))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)

        expect(cfg.command["job-design"]?.agent).toBe("design")
        expect(cfg.command["job-design"]?.template).toContain("autocode_concept_list")
    })

    test("allows assist to call dependency checks", async () => {
        const plugin = await autocode(createPluginInput(createMockClient()))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)

        expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_dependencies")).toBe("allow")
        expect(getPermissionRule(cfg.agent.execute_document?.permission, "autocode_dependencies")).toBeUndefined()
    })

    test("applies native external_directory rules before agent-specific fallback", async () => {
        const plugin = await autocode(createPluginInput(createMockClient()))
        const cfg: ConfigWithRuntimeSections = {
            agent: {},
            command: {},
            permission: {
                external_directory: {
                    "/home/me/CarData/*": "allow",
                },
            },
        }

        await configurePlugin(plugin, cfg)

        expect(getPermissionRule(cfg.agent.design?.permission, "external_directory")).toEqual(expect.objectContaining({
            "*": "ask",
            "/home/me/CarData/*": "allow",
        }))
        expect(getPermissionRule(cfg.agent.execute_os?.permission, "external_directory")).toEqual(expect.objectContaining({
            "*": "allow",
            "/home/me/CarData/*": "allow",
        }))
        expect(getPermissionRule(cfg.agent.assist?.permission, "external_directory")).toEqual(expect.objectContaining({
            "*": "ask",
            "/home/me/CarData/*": "allow",
        }))
        expect(getPermissionRule(cfg.agent.query_code?.permission, "external_directory")).toEqual(expect.objectContaining({
            "*": "deny",
            "/home/me/CarData/*": "allow",
        }))
        expect(getPermissionRule(cfg.agent.auto_general?.permission, "task_external")).toEqual(expect.objectContaining({
            "*": "allow",
            "/home/me/CarData/*": "allow",
        }))
    })

    test("does not register removed job_draft command and keeps current design-research agents", async () => {
        const plugin = await autocode(createPluginInput(createMockClient()))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)

        expect(cfg.command.job_draft).toBeUndefined()
        expect(cfg.agent.plan).toEqual({ disable: true })
        expect(cfg.agent.design?.prompt).toContain("# Solution Designer")
        expect(cfg.agent.research?.prompt).toContain("# Researcher")
    })

    test("registers job-draft command with canonical execute command follow-up", async () => {
        const plugin = await autocode(createPluginInput(createMockClient()))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)

        expect(cfg.command["job-draft"]?.agent).toBe("design")
        expect(cfg.command["job-draft"]?.template).toContain("autocode_plan_save")
        expect(cfg.command["job-draft"]?.template).toContain("Your plan is saved at: `[job_path]`")
        expect(cfg.command["job-draft"]?.template).toContain("Replace [job_path] with `job_path` value from `autocode_plan_save` tool response.")
        expect(cfg.command["job-draft"]?.template).toContain("/job-execute-auto")
        expect(cfg.command["job-draft"]?.template).toContain("/job-execute-assist")
    })

    test("registers job-execute-auto command for planned autonomous execution", async () => {
        const plugin = await autocode(createPluginInput(createMockClient()))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)

        expect(cfg.command["job-execute-auto"]?.agent).toBe("design")
        expect(cfg.command["job-execute-auto"]?.template).toContain("autocode_job_execute")
        expect(cfg.command["job-execute-auto"]?.template).toContain("`agent` = `auto`")
        expect(cfg.command["job-execute-auto"]?.template).toContain("draft_required")
        expect(cfg.command["job-execute-auto"]?.template).not.toContain("list_plans")
        expect(cfg.command["job-execute-auto"]?.template).not.toContain("result_type == \"workflow\"")
    })

    test("registers job-execute-assist command for planned assistive execution", async () => {
        const plugin = await autocode(createPluginInput(createMockClient()))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)

        expect(cfg.command["job-execute-assist"]?.agent).toBe("design")
        expect(cfg.command["job-execute-assist"]?.description).toContain(".agents/jobs/assist")
        expect(cfg.command["job-execute-assist"]?.template).toContain("autocode_job_execute")
        expect(cfg.command["job-execute-assist"]?.template).toContain("`agent` = `assist`")
        expect(cfg.command["job-execute-assist"]?.template).toContain("draft_required")
        expect(cfg.command["job-execute-assist"]?.template).not.toContain("list_plans")
        expect(cfg.command["job-execute-assist"]?.template).not.toContain("result_type == \"workflow\"")
    })

    test("registers job-execute selection command", async () => {
        const plugin = await autocode(createPluginInput(createMockClient()))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)

        expect(cfg.command["job-execute"]?.agent).toBe("temp_execute")
        expect(cfg.command["job-execute"]?.subtask).toBe(false)
        expect(cfg.command["job-execute"]?.template).toContain("autocode_job_list")
        expect(cfg.command["job-execute"]?.template).toContain("question")
        expect(cfg.command["job-execute"]?.template).toContain("autocode_agent_execute")
        expect(cfg.command["job-execute"]?.template).toContain('output includes `current_status`')
    })

    test("registers only canonical lifecycle commands", async () => {
        const plugin = await autocode(createPluginInput(createMockClient()))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)

        expect(cfg.command["save-ideas"]).toBeUndefined()
        expect(cfg.command["auto-redesign"]).toBeUndefined()
        expect(cfg.command["auto-reviewed"]).toBeUndefined()
    })

    test("routes accept, reject, shelve, and legacy command to the current lifecycle agents", async () => {
        const plugin = await autocode(createPluginInput(createMockClient()))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)

        expect(cfg.command["job-review-commit"]?.agent).toBe("execute_git_commit")
        expect(cfg.command["job-review-commit"]?.template).toContain("autocode_job_shelve")
        expect(cfg.command["job-shelve"]?.description).toContain("Shelve current job and move job to .agents/jobs/shelved/{name}/")
        expect(cfg.command["job-shelve"]?.agent).toBe("temp_shelve")
        expect(cfg.command["job-shelve"]?.template).toContain("autocode_job_shelve")
        expect(cfg.command["shelve"]?.description).toContain("Shelve current job and move job to .agents/jobs/shelved/{name}/")
        expect(cfg.command["shelve"]?.agent).toBe("temp_shelve")
        expect(cfg.command["shelve"]?.template).toContain("autocode_job_shelve")
    })

    test("createTools exposes sandbox tools", () => {
        const tools = createTools(createMockClient())
        const sandboxCreate = tools.autocode_sandbox_create as unknown as { description: string, args: Record<string, unknown> }
        const sandboxCli = tools.autocode_sandbox_cli as unknown as { description: string, args: Record<string, unknown> }
        const sandboxDelete = tools.autocode_sandbox_delete as unknown as { description: string }
        const sandboxEdit = tools.autocode_sandbox_edit as unknown as { description: string, args: Record<string, unknown> }
        const sandboxGlob = tools.autocode_sandbox_glob as unknown as { description: string, args: Record<string, unknown> }
        const sandboxGrep = tools.autocode_sandbox_grep as unknown as { description: string, args: Record<string, unknown> }
        const sandboxRead = tools.autocode_sandbox_read as unknown as { description: string, args: Record<string, unknown> }
        const sandboxCopy = tools.autocode_sandbox_copy as unknown as { description: string, args: Record<string, unknown> }
        const skillLearnCorrection = tools.skill_learn_correction as unknown as { description: string, args: Record<string, unknown> }
        const skillLearnEnv = tools.skill_learn_env as unknown as { description: string, args: Record<string, unknown> }
        const skillLearnPermission = tools.skill_learn_permission as unknown as { description: string, args: Record<string, unknown> }
        const skillLearnPreference = tools.skill_learn_preference as unknown as { description: string, args: Record<string, unknown> }
        const skill = tools.skill as unknown as { description: string, args: Record<string, unknown> }

        expect(Object.keys(tools)).toEqual(expect.arrayContaining(["autocode_dependencies", "autocode_job_shelve", "autocode_rest", "autocode_rest_response_read", "autocode_rest_grep", "autocode_rest_response_eval", "autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy", "skill_learn_correction", "skill_learn_env", "skill_learn_permission", "skill_learn_preference", "skill", "git_status", "git_diff_unstaged", "git_diff_staged", "git_diff", "git_log", "git_show", "git_add", "git_commit", "git_reset", "git_create_branch", "git_checkout", "git_branch"]))
        expect(tools.skill).toBeDefined()
        expect(Object.keys(tools)).not.toContain("skill_learn")
        expect(Object.keys((tools.autocode_dependencies as unknown as { args: Record<string, unknown> }).args)).toEqual([])
        expect(Object.keys(tools)).not.toContain("autocode_sandbox_list")
        expect(sandboxCreate.description).toContain("Create")
        expect(sandboxCreate.description).toContain("Omit `distro` for fast startup using read-only host OS filesystem mounts. Use `alpine` for isolated OS/installation testing and experimentation. Use `debian` when Alpine is incompatible with project dependencies or glibc expectations.")
        expect(toolSurfaceText(sandboxCreate)).toContain("Enable sandbox network access; defaults to false.")
        expect(Object.keys(sandboxCreate.args)).toEqual(expect.arrayContaining(["sandbox_name", "distro", "internet_enabled"]))
        expect(Object.keys(sandboxCreate.args)).not.toContain("sync_method")
        expect(Object.keys(sandboxCreate.args)).not.toContain("distro_cache_path")
        expect(sandboxCli.description).toContain("Run")
        expect(Object.keys(sandboxCli.args)).toEqual(["sandbox_name", "command", "working_dir", "timeout"])
        expect(toolSurfaceText(sandboxCli)).not.toContain("internet_enabled")
        expect(toolSurfaceText(sandboxCli)).not.toContain("share-net")
        expect(toolSurfaceText(sandboxCli)).not.toContain("sync_method")
        expect(sandboxDelete.description).toContain("Delete")
        expect(Object.keys(sandboxEdit.args)).toEqual(["sandbox_name", "path", "oldString", "newString", "replaceAll"])
        expect(Object.keys(sandboxGlob.args)).toEqual(["sandbox_name", "pattern", "path", "limit"])
        expect(Object.keys(sandboxGrep.args)).toEqual(["sandbox_name", "pattern", "path", "include", "limit"])
        expect(Object.keys(sandboxRead.args)).toEqual(["sandbox_name", "path", "offset", "limit"])
        expect(Object.keys(sandboxCopy.args)).toEqual(["sandbox_name", "local_source", "local_target", "sandbox_source", "sandbox_target"])
        expect(sandboxEdit.description).toContain("Edit")
        expect(sandboxGlob.description).toContain("Find")
        expect(sandboxGrep.description).toContain("Search")
        expect(sandboxRead.description).toContain("Read")
        expect(sandboxCopy.description).toContain("Copy")
        expect(Object.keys(skillLearnCorrection.args)).toEqual(["title", "content"])
        expect(Object.keys(skillLearnEnv.args)).toEqual(["title", "content"])
        expect(Object.keys(skillLearnPermission.args)).toEqual(["title", "content"])
        expect(Object.keys(skillLearnPreference.args)).toEqual(["title", "content"])
        expect(skillLearnCorrection.description).toContain("mistake was corrected")
        expect(skillLearnEnv.description).toContain("local dev environment")
        expect(skillLearnPreference.description).toContain("reviewer complaint")
        expect(skill.description).toContain("skill")
        expect(Object.keys(skill.args)).toEqual(["name"])
        expect(Object.keys(skill.args)).not.toContain("subjects")
        expect(learnedSkillSubjects).toEqual(["learned_corrections", "learned_env", "learned_permissions", "learned_preferences"])
    })

    test("unsupported sandbox policy disables execute_sandbox and denies explicit sandbox permissions", () => {
        const agents = applySandboxPlatformPolicy({
            auto: { permission: { "*": "allow", autocode_sandbox_create: "allow", autocode_sandbox_cli: "ask", autocode_sandbox_delete: "allow", autocode_sandbox_read: "allow" } },
            execute_sandbox: { disable: false, permission: { "*": "deny", autocode_sandbox_cli: "allow", autocode_sandbox_edit: "allow" } },
        }, "darwin")

        for (const toolName of ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy"]) {
            expect(getPermissionRule(agents.auto?.permission as RuntimePermission, toolName)).toBe("deny")
        }
        expect(agents.execute_sandbox?.disable).toBe(true)
        expect(getPermissionRule(agents.execute_sandbox?.permission as RuntimePermission, "autocode_sandbox_cli")).toBe("deny")
        expect(getPermissionRule(agents.execute_sandbox?.permission as RuntimePermission, "autocode_sandbox_edit")).toBe("deny")
    })

    test("unsupported sandbox policy covers non-linux, android, linux without bwrap, and Termux signals", () => {
        for (const platform of ["win32", "android", "freebsd"] as NodeJS.Platform[]) {
            const agents = applySandboxPlatformPolicy({ execute_sandbox: { disable: false, permission: { autocode_sandbox_cli: "allow" } } }, { platform, bwrapUsable: true })

            expect(agents.execute_sandbox?.disable).toBe(true)
            expect(getPermissionRule(agents.execute_sandbox?.permission as RuntimePermission, "autocode_sandbox_cli")).toBe("deny")
        }

        const missingBwrap = applySandboxPlatformPolicy({ execute_sandbox: { disable: false, permission: { autocode_sandbox_cli: "allow" } } }, { platform: "linux", bwrapUsable: false })
        const termux = applySandboxPlatformPolicy({ execute_sandbox: { disable: false, permission: { autocode_sandbox_cli: "allow" } } }, { platform: "linux", env: { TERMUX_VERSION: "1" }, bwrapUsable: true })

        expect(missingBwrap.execute_sandbox?.disable).toBe(true)
        expect(getPermissionRule(missingBwrap.execute_sandbox?.permission as RuntimePermission, "autocode_sandbox_cli")).toBe("deny")
        expect(termux.execute_sandbox?.disable).toBe(true)
        expect(getPermissionRule(termux.execute_sandbox?.permission as RuntimePermission, "autocode_sandbox_cli")).toBe("deny")
    })

    test("unsupported sandbox policy denies wildcard and top-level string sandbox access without narrowing wildcards", () => {
        const agents = applySandboxPlatformPolicy({
            wildcard: { permission: { "*": "allow", read: "allow" } },
            sandboxWildcard: { permission: { "autocode_sandbox_*": "allow", autocode_dependencies: "allow" } },
            stringPermission: { permission: "ask" },
        }, { platform: "linux", bwrapUsable: false })

        expect(getPermissionRule(agents.wildcard?.permission as RuntimePermission, "*")).toBe("allow")
        expect(getPermissionRule(agents.wildcard?.permission as RuntimePermission, "read")).toBe("allow")
        for (const toolName of ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy"]) {
            expect(getPermissionRule(agents.wildcard?.permission as RuntimePermission, toolName)).toBe("deny")
        }
        expect(getPermissionRule(agents.sandboxWildcard?.permission as RuntimePermission, "autocode_sandbox_*")).toBe("allow")
        expect(getPermissionRule(agents.sandboxWildcard?.permission as RuntimePermission, "autocode_dependencies")).toBe("allow")
        for (const toolName of ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy"]) {
            expect(getPermissionRule(agents.sandboxWildcard?.permission as RuntimePermission, toolName)).toBe("deny")
        }
        expect(getPermissionRule(agents.stringPermission?.permission as RuntimePermission, "*")).toBe("ask")
        expect(getPermissionRule(agents.stringPermission?.permission as RuntimePermission, "autocode_sandbox_cli")).toBe("deny")
    })



    test("registers git_conflict for the assist_git_conflict agent", async () => {
        const plugin = await autocode(createPluginInput(createMockClient()))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)

        expect(cfg.command["git-conflict"]?.agent).toBe("assist_git_conflict")
    })

    test("omits removed legacy public tool names from injected prompts", async () => {
        const plugin = await autocode(createPluginInput(createMockClient()))
        const cfg = createConfig()

        await configurePlugin(plugin, cfg)

        const promptText = injectedPromptText(cfg)
        const legacyToolPatterns = [
            /(^|[^A-Za-z0-9_])autocode_draft_job_/,
            /(^|[^A-Za-z0-9_])autocode_plan_load_/,
            /(^|[^A-Za-z0-9_])autocode_logo(?![A-Za-z0-9_])/,
            /(^|[^A-Za-z0-9_])autocode_act(?![A-Za-z0-9_])/,
            /(^|[^A-Za-z0-9_])autocode_plan_start(?![A-Za-z0-9_])/,
            /(^|[^A-Za-z0-9_])autocode_revise_job(?![A-Za-z0-9_])/,
            /(^|[^A-Za-z0-9_])autocode_feedback(?![A-Za-z0-9_])/,
            /(^|[^A-Za-z0-9_])autocode_review(?![A-Za-z0-9_])/,
            /(^|[^A-Za-z0-9_])autocode_archive(?![A-Za-z0-9_])/,
        ]

        for (const legacyToolPattern of legacyToolPatterns) {
            expect(promptText).not.toMatch(legacyToolPattern)
        }
    })

    test("uses resume prompt when task_resume is not allowed", async () => {
        const prompts: string[] = []
        const parent = createSession("session-1", "/workspace")
        const child = createSession("session-2", "/workspace", {
            "*": "deny",
            task: {
                "*": "deny",
                execute_code: "allow",
            },
        })
        const client: OpencodeClient = {
            session: {
                async get() {
                    return { data: parent }
                },
                children: createChildrenForParent(parent, child),
                async messages() {
                    return {
                        data: createResumeMessages({
                            "*": "deny",
                            task: {
                                "*": "deny",
                            },
                        }),
                    }
                },
                async promptAsync(args: Parameters<OpencodeClient["session"]["promptAsync"]>[0]) {
                    const firstPart = args.body?.parts[0]
                    prompts.push(firstPart?.type === "text" ? firstPart.text : "")
                    return {}
                },
            },
        } as unknown as OpencodeClient

        await createTaskResumeTool(client).execute({}, createToolContext())

        expect(prompts).toEqual([PROMPT_WORK_RESUME])
    })

    test("uses task_resume prompt when task_resume is allowed", async () => {
        const prompts: string[] = []
        const parent = createSession("session-1", "/workspace")
        const child = createSession("session-2", "/workspace", {
            "*": "deny",
            task: {
                "*": "deny",
                execute_code: "allow",
            },
            task_resume: "allow",
        })
        const client: OpencodeClient = {
            session: {
                async get() {
                    return { data: parent }
                },
                children: createChildrenForParent(parent, child),
                async messages() {
                    return {
                        data: createResumeMessages({
                            "*": "deny",
                            task: {
                                "*": "deny",
                            },
                        }),
                    }
                },
                async promptAsync(args: SessionPromptAsyncData) {
                    const firstPart = args.body?.parts[0]
                    prompts.push(firstPart?.type === "text" ? firstPart.text : "")
                    return {}
                },
            },
        } as unknown as OpencodeClient

        await createTaskResumeTool(client).execute({}, createToolContext())

        expect(prompts).toEqual([PROMPT_TASK_RESUME])
    })

    test("resumes interrupted task sessions", async () => {
        const prompts: string[] = []
        const parent = createSession("session-1", "/workspace")
        const child = createSession("session-2", "/workspace", {
            "*": "deny",
            task: {
                "*": "deny",
                execute_code: "allow",
            },
            task_resume: "allow",
        })
        const client: OpencodeClient = {
            session: {
                async get() {
                    return { data: parent }
                },
                children: createChildrenForParent(parent, child),
                async messages() {
                    return {
                        data: createResumeMessages({
                            "*": "deny",
                            task: {
                                "*": "deny",
                            },
                        }, "task"),
                    }
                },
                async promptAsync(args: SessionPromptAsyncData) {
                    const firstPart = args.body?.parts[0]
                    prompts.push(firstPart?.type === "text" ? firstPart.text : "")
                    return {}
                },
            },
        } as unknown as OpencodeClient

        await createTaskResumeTool(client).execute({}, createToolContext())

        expect(prompts).toEqual([PROMPT_TASK_RESUME])
    })

    test("ignores message permission and uses session permission", async () => {
        const prompts: string[] = []
        const parent = createSession("session-1", "/workspace")
        const child = createSession("session-2", "/workspace", {
            "*": "deny",
            task: {
                "*": "deny",
                execute_code: "allow",
            },
            task_resume: "allow",
        })
        const client: OpencodeClient = {
            session: {
                async get() {
                    return { data: parent }
                },
                children: createChildrenForParent(parent, child),
                async messages() {
                    return {
                        data: createResumeMessages({
                            "*": "deny",
                            task: {
                                "*": "deny",
                            },
                        }),
                    }
                },
                async promptAsync(args: SessionPromptAsyncData) {
                    const firstPart = args.body?.parts[0]
                    prompts.push(firstPart?.type === "text" ? firstPart.text : "")
                    return {}
                },
            },
        } as unknown as OpencodeClient

        await createTaskResumeTool(client).execute({}, createToolContext())

        expect(prompts).toEqual([PROMPT_TASK_RESUME])
    })

    test("resumes interrupted children whose latest tool was not task", async () => {
        const prompts: string[] = []
        const parent = createSession("session-1", "/workspace")
        const child = createSession("session-2", "/workspace", {
            task: {
                "*": "deny",
                execute_code: "allow",
            },
            task_resume: "allow",
        })
        const client: OpencodeClient = {
            session: {
                async get() {
                    return { data: parent }
                },
                children: createChildrenForParent(parent, child),
                async messages() {
                    return {
                        data: [{
                            info: {
                                id: "user-1",
                                role: "user",
                                time: { created: 1 },
                            },
                            parts: [],
                        }, {
                            info: {
                                id: "assistant-1",
                                role: "assistant",
                                providerID: "provider",
                                modelID: "model",
                                time: { created: 2 },
                            },
                            parts: [{
                                type: "tool",
                                tool: "edit",
                                messageID: "assistant-1",
                                state: {
                                    status: "running",
                                    time: { start: 3 },
                                },
                            }],
                        }],
                    }
                },
                async promptAsync(args: SessionPromptAsyncData) {
                    const firstPart = args.body?.parts[0]
                    prompts.push(firstPart?.type === "text" ? firstPart.text : "")
                    return {}
                },
            },
        } as unknown as OpencodeClient

        const result = await createTaskResumeTool(client).execute({}, createToolContext())

        expect(result).toBe("Resumed 1 session: session-2. You can now resume your own work.")
        expect(prompts).toEqual([PROMPT_TASK_RESUME])
    })

    test("resumes children with aborted tool state errors", async () => {
        const prompts: string[] = []
        const parent = createSession("session-1", "/workspace")
        const child = createSession("session-2", "/workspace", {
            task: {
                "*": "deny",
                execute_code: "allow",
            },
            task_resume: "allow",
        })
        const client: OpencodeClient = {
            session: {
                async get() {
                    return { data: parent }
                },
                children: createChildrenForParent(parent, child),
                async messages() {
                    return {
                        data: [{
                            info: {
                                id: "user-1",
                                role: "user",
                                time: { created: 1 },
                            },
                            parts: [],
                        }, {
                            info: {
                                id: "assistant-1",
                                role: "assistant",
                                providerID: "provider",
                                modelID: "model",
                                time: { created: 2, completed: 5 },
                            },
                            parts: [{
                                type: "tool",
                                tool: "bash",
                                messageID: "assistant-1",
                                state: {
                                    status: "error",
                                    error: { message: "Request aborted by user" },
                                    time: { start: 3, end: 4 },
                                },
                            }],
                        }],
                    }
                },
                async promptAsync(args: SessionPromptAsyncData) {
                    const firstPart = args.body?.parts[0]
                    prompts.push(firstPart?.type === "text" ? firstPart.text : "")
                    return {}
                },
            },
        } as unknown as OpencodeClient

        const result = await createTaskResumeTool(client).execute({}, createToolContext())

        expect(result).toBe("Resumed 1 session: session-2. You can now resume your own work.")
        expect(prompts).toEqual([PROMPT_TASK_RESUME])
    })

})

describe("autocode_concept_list tool", () => {
    test("registers the tool on the plugin without restoring the removed autocode agent", async () => {
        const plugin = await autocode(createPluginInput({
            session: {
                async get() {
                    return { data: createSession("session-1", "/workspace") }
                },
                async children() {
                    return { data: [] }
                },
                async messages() {
                    return { data: [] }
                },
                async promptAsync() {
                    return {}
                },
            },
        } as unknown as OpencodeClient))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)

        expect(plugin.tool?.autocode_concept_list).toBeDefined()
        expect(cfg.agent.autocode).toBeUndefined()
        expect(getPermissionRule(cfg.agent.auto_general?.permission, "*")).toBe("allow")
    })

    test("returns sorted backlog JSON with names and first non-heading text descriptions after optional front-matter", async () => {
        const reads: string[] = []
        const tool = createAutocodeConceptListTool({
            async readdir(): Promise<Dirent[]> {
                return [
                    createDirent("zeta.md", "file"),
                    createDirent("notes.txt", "file"),
                    createDirent("alpha.md", "file"),
                    createDirent("nested"),
                    createDirent("plain.md", "file"),
                ]
            },
            async readFile(filePath) {
                reads.push(String(filePath))

                if (String(filePath).endsWith("alpha.md")) {
                    return "---\nsource session title: \"Session\"\nsource directory: \"/workspace\"\ncreate: \"2026-06-02 10:11:12\"\nconcept title: \"Alpha\"\n---\n\n   # Alpha Title\n---\n   Intro"
                }

                if (String(filePath).endsWith("zeta.md")) {
                    return "# Zeta Title\nMore"
                }

                if (String(filePath).endsWith("plain.md")) {
                    return `${"a".repeat(161)}`
                }

                return ""
            },
        })

        const result = await tool.execute({}, createToolContext())

        expect(result).toBe(JSON.stringify({
            backlog: [
                { label: "alpha", description: "Intro" },
                { label: "plain", description: `${"a".repeat(160)}...` },
                { label: "zeta", description: "More" },
            ],
        }))
        expect(reads).toEqual([
            "/workspace/.agents/jobs/concepts/alpha.md",
            "/workspace/.agents/jobs/concepts/plain.md",
            "/workspace/.agents/jobs/concepts/zeta.md",
        ])
    })

    test("returns empty backlog JSON when directory is missing", async () => {
        const tool = createAutocodeConceptListTool({
            async readdir() {
                const error = new Error("Missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            },
            async readFile() {
                return ""
            },
        })

        const result = await tool.execute({}, createToolContext())

        expect(result).toBe(JSON.stringify({ backlog: [] }))
    })
})

describe("autocode_concept_read tool", () => {
    test("registers the tool on the plugin with design concept-read permission", async () => {
        const plugin = await autocode(createPluginInput({
            session: {
                async get() {
                    return { data: createSession("session-1", "/workspace") }
                },
                async children() {
                    return { data: [] }
                },
                async messages() {
                    return { data: [] }
                },
                async promptAsync() {
                    return {}
                },
            },
        } as unknown as OpencodeClient))
        const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

        await configurePlugin(plugin, cfg)

        expect(plugin.tool?.autocode_concept_read).toBeDefined()
        expect(getPermissionRule(cfg.agent.general?.permission, "autocode_concept_read")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.design?.permission, "autocode_concept_read")).toBe("allow")
    })

    test("omits one leading front-matter block, creates the draft job directory, and moves the concept", async () => {
        const reads: string[] = []
        const client: OpencodeClient = {
            session: {
                update: mock(async (args: { path: { id: string }, query: { directory: string }, body: { title: string } }) => ({
                    data: { id: args.path.id, title: args.body.title },
                })),
            },
        } as unknown as OpencodeClient
        const mkdir = mock(async (_dirPath: string, _options?: { recursive?: boolean }) => undefined as string | undefined)
        const rename = mock(async (_oldPath: string, _newPath: string) => { })
        const writeFile = mock(async (_filePath: string, _content: string) => { })
        const tool = createAutocodeConceptReadTool(client, {
            mkdir,
            async readFile(filePath) {
                reads.push(String(filePath))
                return "---\nsource session title: \"Session\"\nsource directory: \"/workspace\"\ncreate: \"2026-06-02 10:11:12\"\nconcept title: \"Item Title\"\n---\n\n# Item Title\n\nRaw body\n---\nKeep separator\n"
            },
            rename,
            writeFile,
        })

        const result = await tool.execute({ label: "example-item" }, createToolContext())

        expect(result).toBe("# Item Title\n\nRaw body\n---\nKeep separator\n")
        expect(reads).toEqual([
            "/workspace/.agents/jobs/concepts/example-item.md",
        ])
        expect(mkdir).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/example_item", { recursive: true })
        expect(writeFile).not.toHaveBeenCalled()
        expect(rename).toHaveBeenCalledWith(
            "/workspace/.agents/jobs/concepts/example-item.md",
            "/workspace/.agents/jobs/drafts/example_item/concept.md"
        )
        expect(client.session.update).toHaveBeenCalledWith({
            path: { id: "session-1" },
            query: { directory: "/workspace" },
            body: { title: "Example Item" },
        })
    })

    test("returns a plain text message when the backlog file does not exist", async () => {
        const tool = createAutocodeConceptReadTool({
            async readFile() {
                const error = new Error("Missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            },
        })

        const result = await tool.execute({ label: "missing-item" }, createToolContext())

        expect(result).toBe(createErrorResponse("read concept", "Concept not found: missing-item", "Ask the user to choose another concept or provide their requirement directly."))
    })

    test("uses the default file system when called with a client only", async () => {
        const worktree = mkdtempSync(join(tmpdir(), "autocode-concept-read-"))
        const tool = createAutocodeConceptReadTool({} as OpencodeClient)

        try {
            const result = await tool.execute({ label: "missing-item" }, {
                ...createToolContext(),
                directory: worktree,
                worktree,
            })

            expect(result).toBe(createErrorResponse("read concept", "Concept not found: missing-item", "Ask the user to choose another concept or provide their requirement directly."))
        } finally {
            rmSync(worktree, { recursive: true, force: true })
        }
    })
})

describe("autocode_concept_create tool", () => {
    test("writes front-matter metadata before the concept body", async () => {
        const writes: Array<{ filePath: string, content: string }> = []
        const tool = createAutocodeConceptCreateTool({
            session: {
                get: mock(async () => ({ data: { title: "Current Session" } })),
            },
        } as unknown as OpencodeClient, {
            async mkdir() {
            },
            async stat() {
                const error = new Error("Missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            },
            async writeFile(filePath, content) {
                writes.push({ filePath, content })
            },
        }, () => new Date("2026-06-02T10:11:12"))

        const result = await tool.execute({ label: "Checkout Flow", concept: "# Idea\n\nBuild it." }, createToolContext())

        expect(parseToolResult(result)).toEqual({
            label: "checkout_flow",
            file_path: ".agents/jobs/concepts/checkout_flow.md",
        })
        expect(writes).toEqual([{
            filePath: "/workspace/.agents/jobs/concepts/checkout_flow.md",
            content: "---\nsource session title: \"Current Session\"\nsource directory: \"/workspace\"\ncreate: \"2026-06-02 10:11:12\"\nconcept title: \"Checkout Flow\"\n---\n\n# Idea\n\nBuild it.",
        }])
    })

    test("writes concepts under context.directory when worktree is filesystem root", async () => {
        const writes: Array<{ filePath: string, content: string }> = []
        const tool = createAutocodeConceptCreateTool({
            session: {
                get: mock(async () => ({ data: { title: "Current Session" } })),
            },
        } as unknown as OpencodeClient, {
            async mkdir() {
            },
            async stat() {
                const error = new Error("Missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            },
            async writeFile(filePath, content) {
                writes.push({ filePath, content })
            },
        }, () => new Date("2026-06-02T10:11:12"))

        const result = await tool.execute({ label: "Checkout Flow", concept: "Body" }, {
            ...createToolContext(),
            directory: "/workspace/fallback",
            worktree: "/",
        })

        expect(parseToolResult(result)).toEqual({
            label: "checkout_flow",
            file_path: ".agents/jobs/concepts/checkout_flow.md",
        })
        expect(writes).toEqual([{
            filePath: "/workspace/fallback/.agents/jobs/concepts/checkout_flow.md",
            content: "---\nsource session title: \"Current Session\"\nsource directory: \"/workspace/fallback\"\ncreate: \"2026-06-02 10:11:12\"\nconcept title: \"Checkout Flow\"\n---\n\nBody",
        }])
    })

    test("writes an empty source session title when lookup is unavailable", async () => {
        const writes: string[] = []
        const tool = createAutocodeConceptCreateTool(undefined, {
            async mkdir() {
            },
            async stat() {
                const error = new Error("Missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            },
            async writeFile(_filePath, content) {
                writes.push(content)
            },
        }, () => new Date("2026-06-02T10:11:12"))

        await tool.execute({ label: "Checkout Flow", concept: "Body" }, createToolContext())

        expect(writes[0]).toContain('source session title: ""')
    })
})

describe("shared tool error handling", () => {
    test("returns abort response when task_resume cannot inspect the current session", async () => {
        const tool = createTaskResumeTool({
            session: {
                async get() {
                    return { error: { message: "Session lookup failed", code: "ESESSION" } }
                },
                async children() {
                    return { data: [] }
                },
                async messages() {
                    return { data: [] }
                },
                async promptAsync() {
                    return {}
                },
            },
        } as unknown as OpencodeClient)

        const result = await tool.execute({}, createToolContext())

        expect(result).toBe(createAbortResponse("inspect current session", { message: "Session lookup failed", code: "ESESSION" }))
    })
})

describe("autocode_plan_save tool", () => {
    test("registers consolidated plan tools and grants plan permission", async () => {
        const client = createMockClient()
        const plugin = await autocode(createPluginInput(client))
        const cfg = createConfig()
        await configurePlugin(plugin, cfg)
        expect(Object.keys(plugin.tool ?? {}).sort()).toEqual([
            "autocode_agent_execute",
            "autocode_agent_previous",
            "autocode_agent_swap",
            "autocode_concept_create",
            "autocode_concept_list",
            "autocode_concept_read",
            "autocode_plan_read",
            "autocode_plan_save",
            "autocode_db_table",
            "autocode_db_table_read",
            "autocode_db_tables",
            "autocode_job_execute",
            "autocode_job_list",
            "autocode_job_shelve",
            "autocode_job_status",
            "autocode_logo_find",
            "autocode_db_schemas",
            "autocode_dependencies",
            "autocode_rest",
            "autocode_rest_grep",
            "autocode_rest_response_eval",
            "autocode_rest_response_read",
            "autocode_sandbox_cli",
            "autocode_sandbox_copy",
            "autocode_sandbox_create",
            "autocode_sandbox_delete",
            "autocode_sandbox_edit",
            "autocode_sandbox_glob",
            "autocode_sandbox_grep",
            "autocode_sandbox_read",
            "autocode_session_context",
            "autocode_session_create",
            "skill_learn_correction",
            "skill_learn_env",
            "skill_learn_permission",
            "skill_learn_preference",
            "git_add",
            "git_branch",
            "git_checkout",
            "git_commit",
            "git_create_branch",
            "git_diff",
            "git_diff_staged",
            "git_diff_unstaged",
            "git_log",
            "git_reset",
            "git_show",
            "git_status",
            "skill",
            "task_external",
            "task_resume",
        ].sort())
        expect(plugin.tool?.autocode_draft_job_create).toBeUndefined()
        expect(plugin.tool?.autocode_draft_job_update).toBeUndefined()
        expect(plugin.tool?.autocode_plan_save).toBeDefined()
        expect(plugin.tool?.autocode_plan_read).toBeDefined()
        expect(toolSurfaceText(plugin.tool?.autocode_plan_save)).toContain("Create or update plan.md for a planned job.")
        expect(toolSurfaceText(plugin.tool?.autocode_plan_save)).toContain("Define observed wrong/missing project behavior or missing info.")
        expect(toolSurfaceText(plugin.tool?.autocode_plan_save)).toContain("Define expected outcome from user perspective.")
        expect(toolSurfaceText(plugin.tool?.autocode_plan_save)).toContain("Propose simplest approach to meet REQUIREMENTS within CONSTRAINTS:")
        expect(toolSurfaceText(plugin.tool?.autocode_plan_save)).not.toContain("job_name")
        expect(toolSurfaceText(plugin.tool?.autocode_plan_save)).not.toContain("suggested_name")
        expect(toolSurfaceText(plugin.tool?.autocode_plan_save)).not.toContain("concept_label")
        expect(toolSurfaceText(plugin.tool?.autocode_plan_save)).not.toContain("Compatibility alias")
        expect(toolSurfaceText(plugin.tool?.autocode_plan_read)).toContain("Read your solution plan of your job.")
        expect(toolSurfaceText(plugin.tool?.autocode_plan_read)).toContain("Planned job_name if known, otherwise omit to look it up.")
        expect(plugin.tool?.autocode_plan_load_problem).toBeUndefined()
        expect(plugin.tool?.autocode_plan_load_risks).toBeUndefined()
        expect(plugin.tool?.autocode_draft_job_read).toBeUndefined()
        expect(plugin.tool?.autocode_job_list).toBeDefined()
        expect(plugin.tool?.autocode_job_status).toBeDefined()
        expect(toolSurfaceText(plugin.tool?.autocode_job_status)).toContain("Update canonical lifecycle statuses for jobs under .agents/jobs/*.")
        expect(toolSurfaceText(plugin.tool?.autocode_job_status)).not.toContain("agent=assist")
        expect(toolSurfaceText(plugin.tool?.autocode_job_status)).not.toContain("job_name")
        expect(toolSurfaceText(plugin.tool?.autocode_job_status)).not.toContain("report_content")
        expect(plugin.tool?.autocode_logo_find).toBeDefined()
        expect(plugin.tool?.autocode_logo).toBeUndefined()
        expect(toolSurfaceText(plugin.tool?.autocode_job_list)).toContain("List active drafts/jobs.")
        expect(toolSurfaceText(plugin.tool?.autocode_job_list)).toContain("Optional filter limits results to one active status")
        expect(toolSurfaceText(plugin.tool?.autocode_job_list)).toContain("omit to list all active jobs")
        expect(toolSurfaceText(plugin.tool?.autocode_job_list)).toContain("Omit to view all or provide one of these status filters: concepts, drafts, assist, executing, facilitate, review")
        expect(plugin.tool?.autocode_act_prompt).toBeUndefined()
        expect(plugin.tool?.autocode_act).toBeUndefined()
        expect(plugin.tool?.autocode_agent_execute).toBeDefined()
        expect(plugin.tool?.autocode_agent_previous).toBeDefined()
        expect(plugin.tool?.autocode_agent_swap).toBeDefined()
        expect(plugin.tool?.autocode_session_context).toBeDefined()
        expect(Object.keys((plugin.tool?.autocode_session_context as unknown as { args: Record<string, unknown> }).args)).toEqual([])
        expect(toolSurfaceText(plugin.tool?.autocode_session_context)).toContain("Read sanitized current session context and token usage metadata.")
        expect(plugin.tool?.autocode_session_create).toBeDefined()
        expect(plugin.tool?.skill_learn).toBeUndefined()
        expect(plugin.tool?.skill_learn_correction).toBeDefined()
        expect(plugin.tool?.skill_learn_env).toBeDefined()
        expect(plugin.tool?.skill_learn_permission).toBeDefined()
        expect(plugin.tool?.skill_learn_preference).toBeDefined()
        expect(Object.keys((plugin.tool?.skill_learn_correction as unknown as { args: Record<string, unknown> }).args)).toEqual(["title", "content"])
        expect(Object.keys((plugin.tool?.skill_learn_env as unknown as { args: Record<string, unknown> }).args)).toEqual(["title", "content"])
        expect(Object.keys((plugin.tool?.skill_learn_permission as unknown as { args: Record<string, unknown> }).args)).toEqual(["title", "content"])
        expect(Object.keys((plugin.tool?.skill_learn_preference as unknown as { args: Record<string, unknown> }).args)).toEqual(["title", "content"])
        expect(plugin.tool?.skill).toBeDefined()
        expect(Object.keys((plugin.tool?.skill as unknown as { args: Record<string, unknown> }).args)).toEqual(["name"])
        expect(toolSurfaceText(plugin.tool?.skill)).toContain("skill")
        expect(plugin.tool?.autocode_job_execute).toBeDefined()
        expect(plugin.tool?.autocode_execute_job).toBeUndefined()
        expect(toolSurfaceText(plugin.tool?.autocode_agent_execute)).toContain("Move selected job to execution status")
        expect(toolSurfaceText(plugin.tool?.autocode_agent_execute)).toContain("Selected planned job_name in safe snake_case.")
        expect(toolSurfaceText(plugin.tool?.autocode_agent_swap)).toContain("Swap agent in this session.")
        expect(toolSurfaceText(plugin.tool?.autocode_agent_swap)).toContain("Name of agent to swap to.")
        expect(Object.keys((plugin.tool?.autocode_agent_previous as unknown as { args: Record<string, unknown> }).args)).toEqual([])
        const sessionCreateToolText = toolSurfaceText(plugin.tool?.autocode_session_create)
        expect(sessionCreateToolText).toContain("Hand off task to new session.")
        expect(sessionCreateToolText).toContain("Agent to execute task.")
        expect(sessionCreateToolText).toContain("Context or instructions to new agent.")
        expect(toolSurfaceText(plugin.tool?.autocode_job_execute)).not.toContain("job_name")
        expect(plugin.tool?.autocode_concept_create).toBeDefined()
        expect(plugin.tool?.autocode_plan_start).toBeUndefined()
        expect(plugin.tool?.autocode_db_table).toBeDefined()
        expect(plugin.tool?.autocode_db_table_read).toBeDefined()
        expect(plugin.tool?.autocode_db_tables).toBeDefined()
        expect(plugin.tool?.autocode_dependencies).toBeDefined()
        expect(plugin.tool?.autocode_rest).toBeDefined()
        expect(plugin.tool?.autocode_rest_response_read).toBeDefined()
        expect(plugin.tool?.autocode_rest_grep).toBeDefined()
        expect(plugin.tool?.autocode_rest_response_eval).toBeDefined()
        expect(toolSurfaceText(plugin.tool?.autocode_dependencies)).toContain("Detect Autocode runtime dependencies")
        expect(plugin.tool?.autocode_revise_job).toBeUndefined()
        expect(plugin.tool?.autocode_feedback).toBeUndefined()
        expect(plugin.tool?.autocode_review).toBeUndefined()
        expect(plugin.tool?.autocode_archive).toBeUndefined()
        expect(cfg.agent.act).toBeUndefined()
        expect(cfg.agent.ask).toBeUndefined()
        expect(cfg.agent.autocode).toBeUndefined()
        expect(cfg.agent.plan).toEqual({ disable: true })
        expect(getPermissionRule(cfg.agent.design?.permission, "autocode_agent_execute")).toBe("allow")
        expect(getPermissionRule(cfg.agent.design?.permission, "autocode_agent_previous")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.design?.permission, "autocode_agent_swap")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.design?.permission, "autocode_concept_list")).toBe("allow")
        expect(getPermissionRule(cfg.agent.design?.permission, "autocode_concept_read")).toBe("allow")
        expect(getPermissionRule(cfg.agent.temp_execute?.permission, "autocode_agent_execute")).toBe("allow")
        expect(getPermissionRule(cfg.agent.temp_execute?.permission, "autocode_job_list")).toBe("allow")
        expect(getPermissionRule(cfg.agent.temp_execute?.permission, "question")).toBe("allow")
        expect(getPermissionRule(cfg.agent.temp_execute?.permission, "autocode_agent_previous")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.temp_execute?.permission, "autocode_agent_swap")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.temp_execute?.permission, "autocode_plan_read")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.design?.permission, "autocode_plan_save")).toBe("allow")
        expect(getPermissionRule(cfg.agent.design?.permission, "autocode_job_execute")).toBe("allow")
        expect(getPermissionRule(cfg.agent.design?.permission, "autocode_session_create")).toBe("allow")
        expect(getPermissionRule(cfg.agent.execute_author?.permission, "autocode_logo_find")).toBe("allow")
        expect(getPermissionRule(cfg.agent.execute_author?.permission, "autocode_agent_previous")).toBe("allow")
        expect(getPermissionRule(cfg.agent.execute_author?.permission, "autocode_agent_swap")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.execute_author?.permission, "autocode_session_create")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.execute_author?.permission, "autocode_logo")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_dependencies")).toBe("allow")
        expect(getPermissionRule(cfg.agent.execute_document?.permission, "autocode_dependencies")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.auto_general?.permission, "*")).toBe("allow")
        expect(getPermissionRule(cfg.agent.auto_general?.permission, "doom_loop")).toBe("deny")
        expect(getPermissionRule(cfg.agent.auto_general?.permission, "task_resume")).toBe("allow")
        expect(getTaskPermissionRule(cfg.agent.auto_general?.permission, "design")).toBe("deny")
        expect(getTaskPermissionRule(cfg.agent.auto_general?.permission, "research")).toBe("deny")
        expect(cfg.agent.auto_general?.prompt).toContain("fallback auto orchestrator")
        expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_agent_previous")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_agent_swap")).toBe("allow")
        expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_session_create")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_feedback")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_review")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_job_list")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_plan_read")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_plan_save")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_draft_job_create")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_agent_previous")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_agent_swap")).toBe("allow")
        expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_session_create")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_plan_read")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_job_list")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_job_status")).toBe("allow")
        expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_auto_start")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_plan_save")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.temp_output?.permission, "autocode_session_context")).toBe("allow")
        expect(Object.keys(cfg.agent).filter((name) => name.startsWith("auto-") || name.startsWith("assist-"))).toEqual([])
        expect(cfg.agent.design?.prompt).toContain("PROPOSAL")
        expect(cfg.agent.design?.prompt).toContain("autocode_plan_save")
        expect(cfg.agent.design?.prompt).toContain("autocode_job_execute")
        expect(cfg.agent.research?.prompt).toContain("Research Workflow")
        expect(cfg.agent.research?.prompt).toContain("Task `query*` subagents")
        const queryDbAgent = (cfg.agent as Record<string, Record<string, unknown>>).query_db
        expect((queryDbAgent.permission as Record<string, unknown> | undefined)?.autocode_agent_previous).toBeUndefined()
        expect((queryDbAgent.permission as Record<string, unknown> | undefined)?.autocode_agent_swap).toBeUndefined()
        expect((queryDbAgent.permission as Record<string, unknown> | undefined)?.autocode_session_create).toBeUndefined()
        expect(queryDbAgent.mode).toBe("subagent")
        expect(queryDbAgent.hidden).toBe(true)
        expect(String(queryDbAgent.prompt)).toContain("Use only `autocode_db_tables`, `autocode_db_table`, and `autocode_db_table_read`")
        expect(String(queryDbAgent.prompt)).toContain("AUTOCODE_DB_<UPPERCASE_KEY>_CONNECTION")
        expect(queryDbAgent.permission).toEqual(expect.objectContaining({
            "*": "deny",
            autocode_db_table: "allow",
            autocode_db_table_read: "allow",
            autocode_db_tables: "allow",
            doom_loop: "deny",
            external_directory: expect.objectContaining({ "*": "deny" }),
        }))
        const executeRestAgent = (cfg.agent as Record<string, Record<string, unknown>>).execute_rest
        expect(getAgentField(cfg, "execute_rest", "mode")).toBe("subagent")
        expect(getAgentField(cfg, "execute_rest", "hidden")).toBe(true)
        expect(executeRestAgent.tier).toBeUndefined()
        expect(getAgentField(cfg, "execute_rest", "temperature")).toBe(0.1)
        expect(String(executeRestAgent.prompt)).toContain("autocode_rest")
        expect(String(executeRestAgent.prompt)).toContain("autocode_rest_response_read")
        expect(String(executeRestAgent.prompt)).toContain("autocode_rest_grep")
        expect(String(executeRestAgent.prompt)).toContain("autocode_rest_response_eval")
        expect(String(executeRestAgent.prompt)).toContain("GET, POST, PUT, PATCH, DELETE")
        expect(String(executeRestAgent.prompt)).toContain("Values in `query` map override same query keys already in URL")
        expect(String(executeRestAgent.prompt)).toContain("truncated: true")
        expect(String(executeRestAgent.prompt)).toContain("Never dump full raw REST result unless user specifically asks")
        expect(String(executeRestAgent.prompt)).toContain("Do not leak sensitive headers or body unless user explicitly requested")
        expect(String(executeRestAgent.prompt)).toContain("ask user confirmation")
        expect(String(executeRestAgent.prompt)).toContain("Caveman English")
        expect(executeRestAgent.permission).toEqual(expect.objectContaining({
            "*": "deny",
            autocode_rest: "allow",
            autocode_rest_grep: "allow",
            autocode_rest_response_eval: "allow",
            autocode_rest_response_read: "allow",
            doom_loop: "deny",
            external_directory: expect.objectContaining({ "*": "deny" }),
        }))
        expect(getPermissionRule(cfg.agent.execute_rest?.permission, "session")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.execute_rest?.permission, "agent")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.execute_rest?.permission, "previous_session")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.execute_rest?.permission, "previous_agent")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.execute_rest?.permission, "autocode_session_create")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.execute_rest?.permission, "autocode_agent_swap")).toBeUndefined()
        expect(getPermissionRule(cfg.agent.execute_rest?.permission, "autocode_agent_previous")).toBeUndefined()
    })
})

describe("autocode_logo_find tool", () => {
    const expectedNotFoundResult = {
        found: false,
        path: null,
        message: "No logo or favicon found.",
        searched: [
            "assets/logo.svg",
            "assets/logo.webp",
            "assets/logo.png",
            "assets/logo.jpg",
            "images/logo.svg",
            "images/logo.webp",
            "images/logo.png",
            "images/logo.jpg",
            "docs/logo.svg",
            "docs/logo.webp",
            "docs/logo.png",
            "docs/logo.jpg",
            "docs/images/logo.svg",
            "docs/images/logo.webp",
            "docs/images/logo.png",
            "docs/images/logo.jpg",
            "assets/favicon.svg",
            "assets/favicon.webp",
            "assets/favicon.png",
            "assets/favicon.jpg",
            "static/favicon.svg",
            "static/favicon.webp",
            "static/favicon.png",
            "static/favicon.jpg",
            "public/favicon.svg",
            "public/favicon.webp",
            "public/favicon.png",
            "public/favicon.jpg",
        ],
    }

    test("returns the first logo path in search order", async () => {
        const existing = new Set(["/workspace/docs/logo.svg", "/workspace/assets/favicon.png"])
        const tool = createAutocodeLogoFindTool({
            async access(filePath: string) {
                if (!existing.has(filePath)) {
                    throw Object.assign(new Error("Missing file"), { code: "ENOENT" })
                }
            },
        })

        const result = parseToolResult(await tool.execute({}, createToolContext()))

        expect(result).toEqual({ found: true, path: "docs/logo.svg" })
    })

    test("checks svg, webp, png, jpg extension priority for a candidate location", async () => {
        const checked: string[] = []
        const existing = new Set(["/workspace/assets/logo.jpg"])
        const tool = createAutocodeLogoFindTool({
            async access(filePath: string) {
                checked.push(filePath)

                if (!existing.has(filePath)) {
                    throw Object.assign(new Error("Missing file"), { code: "ENOENT" })
                }
            },
        })

        const result = parseToolResult(await tool.execute({}, createToolContext()))

        expect(result).toEqual({ found: true, path: "assets/logo.jpg" })
        expect(checked).toEqual([
            "/workspace/assets/logo.svg",
            "/workspace/assets/logo.webp",
            "/workspace/assets/logo.png",
            "/workspace/assets/logo.jpg",
        ])
    })

    test("returns structured not found result", async () => {
        const tool = createAutocodeLogoFindTool({
            async access() {
                throw Object.assign(new Error("Missing file"), { code: "ENOENT" })
            },
        })

        const result = parseToolResult(await tool.execute({}, createToolContext()))

        expect(result).toEqual(expectedNotFoundResult)
    })

    test("returns structured not found result for unexpected search errors", async () => {
        const tool = createAutocodeLogoFindTool({
            async access() {
                throw new Error("Unexpected search failure")
            },
        })

        const result = parseToolResult(await tool.execute({}, createToolContext()))

        expect(result).toEqual(expectedNotFoundResult)
        expect(result.type).toBeUndefined()
        expect(result.corrective_action).toBeUndefined()
    })
})

describe("autocode_plan_save behaviour", () => {
    function createMockFs(readdirResult: { name: string, type?: "file" | "directory" }[][] = []) {
        let readdirCallCount = 0
        const readdir: ReaddirWithFileTypes = async (_dirPath, _opts) => {
            if (readdirResult.length === 0) return []
            const result = readdirResult[readdirCallCount] ?? []
            readdirCallCount++
            return result.map((entry) => createDirent(entry.name, entry.type))
        }

        return {
            mkdir: mock(async (_path: string, _opts?: { recursive?: boolean }) => undefined as string | undefined),
            writeFile: mock(async (_path: string, _content: string) => { }),
            readFile: mock(async (_path: string, _encoding: "utf8"): Promise<string> => {
                throw createMissingFileError()
            }),
            rm: mock(async (_path: string, _opts?: { recursive?: boolean, force?: boolean }) => { }),
            stat: mock(async (_path: string) => ({ mtimeMs: Date.now() })),
            readdir: mock(readdir),
            rename: mock(async (_oldPath: string, _newPath: string) => { }),
        }
    }

    function createPlanSaveClient(title: string, updateImpl?: (args: { path: { id: string }, query: { directory: string }, body: { title: string } }) => Promise<{ data?: unknown, error?: string }>): OpencodeClient {
        return {
            session: {
                get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                    data: { id: args.path.id, title },
                })),
                update: mock(updateImpl ?? (async (args: { path: { id: string }, query: { directory: string }, body: { title: string } }) => ({
                    data: { id: args.path.id, title: args.body.title },
                }))),
            },
        } as unknown as OpencodeClient
    }

    test("creates a new draft plan from the current session title", async () => {
        const fs = createMockFs()
        const client = createPlanSaveClient("My Feature")
        const tool = createAutocodePlanSaveTool(client, fs)
        const parsed = parseToolResult(await executePlanSave(tool, { problems: "Problem text" }))

        expect(parsed).toEqual({
            job_name: "my_feature",
            job_path: "/workspace/.agents/jobs/drafts/my_feature/plan.md",
        })
        expect(fs.mkdir).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/my_feature", { recursive: true })
        expect(fs.writeFile).toHaveBeenCalledWith(
            "/workspace/.agents/jobs/drafts/my_feature/plan.md",
            "\n## Problems\n\nProblem text\n\n---\n\n## Impact\n\n\n\n---\n\n## Expectations\n\n\n\n---\n\n## Requirements\n\n\n\n---\n\n## Risks\n\n\n\n---\n\n## Constraints\n\n\n\n---\n\n## Proposal\n\n\n"
        )
        expect((client as any).session.update).toHaveBeenCalledWith({
            path: { id: "session-1" },
            query: { directory: "/workspace" },
            body: { title: "My Feature" },
        })
        expect(fs.rename).not.toHaveBeenCalled()
    })

    test("saves current problems arg", async () => {
        const fs = createMockFs()
        const client = createPlanSaveClient("My Feature")
        const tool = createAutocodePlanSaveTool(client, fs)

        await executePlanSave(tool, { problems: "Legacy problem text" })

        expect(fs.writeFile).toHaveBeenCalledWith(
            "/workspace/.agents/jobs/drafts/my_feature/plan.md",
            expect.stringContaining("## Problems\n\nLegacy problem text")
        )
    })

    test("updates the title-inferred job when the draft already exists", async () => {
        const fs = createMockFs([[{ name: "my_feature" }]])
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/drafts/my_feature/plan.md") {
                return "# Problems\n\nOld problem\n\n---\n\n# Requirements\n\n\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposal\n\nOld solution\n"
            }
            const error = new Error("missing") as NodeJS.ErrnoException
            error.code = "ENOENT"
            throw error
        })
        const tool = createAutocodePlanSaveTool(createPlanSaveClient("My Feature"), fs)
        const parsed = parseToolResult(await tool.execute({ problems: "Updated problem" }, createToolContext()))

        expect(parsed).toEqual({
            job_name: "my_feature",
            job_path: "/workspace/.agents/jobs/drafts/my_feature/plan.md",
        })
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/my_feature/plan.md", "\n## Problems\n\nUpdated problem\n\n---\n\n## Impact\n\n\n\n---\n\n## Expectations\n\n\n\n---\n\n## Requirements\n\n\n\n---\n\n## Risks\n\n\n\n---\n\n## Constraints\n\n\n\n---\n\n## Proposal\n\nOld solution\n")
    })

    test("uses session-title slug derivation for special characters and truncation", async () => {
        const fs = createMockFs()
        const parsed = parseToolResult(await executePlanSave(createAutocodePlanSaveTool(createPlanSaveClient("Hello World! Test--Case"), fs), { problems: "Problem text" }))
        expect(parsed).toEqual({
            job_name: "hello_world_test_case",
            job_path: "/workspace/.agents/jobs/drafts/hello_world_test_case/plan.md",
        })

        const longTitle = "a".repeat(150)
        const parsed2 = parseToolResult(await executePlanSave(createAutocodePlanSaveTool(createPlanSaveClient(longTitle), createMockFs()), { problems: "Problem text" }))
        expect(parsed2.job_name).toBe("a".repeat(100))
        expect(parsed2.job_path).toBe(`/workspace/.agents/jobs/drafts/${"a".repeat(100)}/plan.md`)
    })

    test("preserves missing sections during partial update without moving concept files", async () => {
        const fs = createMockFs([[{ name: "my_feature" }]])
        fs.readFile.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/jobs/drafts/my_feature/plan.md") {
                return "# Problems\n\nOld problem\n\n---\n\n# Requirements\n\n### Requirement One\nKeep this\n\n---\n\n# Constraints\n\n### Constraint One\nKeep this\n\n---\n\n# Risks\n\n### Risk One\nKeep this\n\n---\n\n# Proposal\n\nShip it\n"
            }
            const error = new Error("missing") as NodeJS.ErrnoException
            error.code = "ENOENT"
            throw error
        })
        const tool = createAutocodePlanSaveTool(createPlanSaveClient("My Feature"), fs)
        const parsed = parseToolResult(await tool.execute({ constraints: "### Constraint Two\nChange this" }, createToolContext()))

        expect(parsed).toEqual({
            job_name: "my_feature",
            job_path: "/workspace/.agents/jobs/drafts/my_feature/plan.md",
        })
        expect(fs.writeFile).toHaveBeenCalledWith(
            "/workspace/.agents/jobs/drafts/my_feature/plan.md",
            "\n## Problems\n\nOld problem\n\n---\n\n## Impact\n\n\n\n---\n\n## Expectations\n\n\n\n---\n\n## Requirements\n\n### Requirement One\nKeep this\n\n---\n\n## Risks\n\n### Risk One\nKeep this\n\n---\n\n## Constraints\n\n### Constraint Two\nChange this\n\n---\n\n## Proposal\n\nShip it\n"
        )
        expect(fs.rename).not.toHaveBeenCalled()
    })

    test("returns retry response when the current session title cannot produce a valid job_name", async () => {
        const fs = createMockFs()
        const tool = createAutocodePlanSaveTool(createPlanSaveClient("***"), fs)
        const parsed = parseToolResult(await tool.execute({ problems: "Problem text" }, createToolContext()))

        expect(parsed.failedAction).toBe("save plan")
        expect(parsed.error).toBe("Unable to derive a valid job_name from the current session title: ***")
    })

    test("missing content returns retry response", async () => {
        const fs = createMockFs()
        const tool = createAutocodePlanSaveTool(createPlanSaveClient("My Feature"), fs)
        const parsed = parseToolResult(await executePlanSave(tool, {}))
        expect(parsed.error).toBe("Missing required plan content")
    })

    test("save still succeeds when session title update fails", async () => {
        const fs = createMockFs()
        const client = createPlanSaveClient("My Feature", async () => ({ error: "update failed" }))
        const tool = createAutocodePlanSaveTool(client, fs)
        const parsed = parseToolResult(await executePlanSave(tool, { problems: "Problem text" }))

        expect(parsed).toEqual({
            job_name: "my_feature",
            job_path: "/workspace/.agents/jobs/drafts/my_feature/plan.md",
        })
    })

    test("writes plan under context.directory when worktree is filesystem root", async () => {
        const fs = createMockFs()
        const client = createPlanSaveClient("My Feature")
        const tool = createAutocodePlanSaveTool(client, fs)

        const parsed = parseToolResult(await tool.execute({ problems: "Problem text" }, {
            ...createToolContext(),
            directory: "/workspace/fallback",
            worktree: "/",
        }))

        expect(parsed).toEqual({
            job_name: "my_feature",
            job_path: "/workspace/fallback/.agents/jobs/drafts/my_feature/plan.md",
        })
        expect(fs.mkdir).toHaveBeenCalledWith("/workspace/fallback/.agents/jobs/drafts/my_feature", { recursive: true })
        expect(fs.writeFile).toHaveBeenCalledWith(
            "/workspace/fallback/.agents/jobs/drafts/my_feature/plan.md",
            "\n## Problems\n\nProblem text\n\n---\n\n## Impact\n\n\n\n---\n\n## Expectations\n\n\n\n---\n\n## Requirements\n\n\n\n---\n\n## Risks\n\n\n\n---\n\n## Constraints\n\n\n\n---\n\n## Proposal\n\n\n"
        )
    })

    test("FS error on mkdir returns abort response", async () => {
        const readdir: ReaddirWithFileTypes = async (_path, _opts) => []
        const fsErr = {
            mkdir: mock(async () => { throw new Error("disk full") }),
            writeFile: mock(async (_filePath: string, _content: string) => { }),
            readFile: mock(async () => { throw createMissingFileError() }),
            rm: mock(async () => { }),
            stat: mock(async () => ({ mtimeMs: Date.now() })),
            readdir: mock(readdir),
        }
        const tool = createAutocodePlanSaveTool(createPlanSaveClient("My Feature"), fsErr)
        const parsed = parseToolResult(await executePlanSave(tool, { problems: "Problem text" }))
        expect(parsed.instruction).toContain("ABORT")
    })
})

describe("autocode_plan tools", () => {
    test("composes canonical seven-section plan.md structure", () => {
        const plan = composePlanMarkdown({
            problems: "Problem text",
            impact: "Impact text",
            expectations: "Expectation text",
            requirements: "### Required\nDo it",
            risks: "### Risk\nWatch it",
            constraints: "### Constraint\nKeep it",
            proposal: "Ship it",
        })

        expect([...plan.matchAll(/^## .+$/gm)].map(([heading]) => heading)).toEqual([
            "## Problems",
            "## Impact",
            "## Expectations",
            "## Requirements",
            "## Risks",
            "## Constraints",
            "## Proposal",
        ])
        expect(plan).toContain("## Problems\n\nProblem text\n\n---\n\n## Impact\n\nImpact text")
        expect(plan).not.toContain("# Plan")
        expect(plan).not.toContain("goal.md")
    })

    test("updates an existing execute plan by job_name", async () => {
        const fs = {
            readFile: mock(async (filePath: string) => {
                if (filePath === "/workspace/.agents/jobs/drafts/my_feature/plan.md") return "# Problems\n\nOld\n\n---\n\n# Requirements\n\n\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposal\n\nShip it\n"
                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            }),
            writeFile: mock(async () => { }),
            mkdir: mock(async () => undefined),
            rm: mock(async () => { }),
            stat: mock(async () => ({ mtimeMs: Date.now() })),
            rename: mock(async () => { }),
        }
        const client: OpencodeClient = {
            session: {
                get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                    data: { id: args.path.id, title: "My Feature" },
                })),
                update: mock(async (args: { path: { id: string }, query: { directory: string }, body: { title: string } }) => ({
                    data: { id: args.path.id, title: args.body.title },
                })),
            },
        } as unknown as OpencodeClient
        const tool = createAutocodePlanSaveTool(client, fs)

        const result = await executePlanSave(tool, { problems: "Problem text" })

        const parsed = parseToolResult(result)
        expect(parsed).toEqual({
            job_name: "my_feature",
            job_path: "/workspace/.agents/jobs/drafts/my_feature/plan.md",
        })
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/my_feature/plan.md", "\n## Problems\n\nProblem text\n\n---\n\n## Impact\n\n\n\n---\n\n## Expectations\n\n\n\n---\n\n## Requirements\n\n\n\n---\n\n## Risks\n\n\n\n---\n\n## Constraints\n\n\n\n---\n\n## Proposal\n\nShip it\n")
    })

    test("reads whole new-format plan.md fields", async () => {
        const plan = "# Problems\n\nProblem text\n\n---\n\n# Impact\n\nImpact text\n\n---\n\n# Expectations\n\nExpectation text\n\n---\n\n# Requirements\n\n### Preserve Markdown\n- Keep lists\n> Keep quotes\n```ts\nconst value = \"## not a section\"\n```\n\n---\n\n# Risks\n\n### Migration Hazard\nMitigate carefully.\n\n---\n\n# Constraints\n\n### Keep Configs\n```yaml\nkey: value\n```\n\n---\n\n# Proposal\n\nShip it\n"
        const fs = {
            readFile: mock(async (filePath: string) => {
                if (filePath === "/workspace/.agents/jobs/drafts/my_feature/plan.md") return plan
                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            }),
            writeFile: mock(async () => { }),
        }
        const tool = createAutocodePlanReadTool(fs)

        const result = await tool.execute({ job_name: "my_feature" }, createToolContext())
        const parsed = parseToolResult(result)
        expect(parsed).toEqual({
            job_name: "my_feature",
            file_path: ".agents/jobs/drafts/my_feature/plan.md",
            problems: "Problem text",
            impact: "Impact text",
            expectations: "Expectation text",
            requirements: "### Preserve Markdown\n- Keep lists\n> Keep quotes\n```ts\nconst value = \"## not a section\"\n```",
            risks: "### Migration Hazard\nMitigate carefully.",
            constraints: "### Keep Configs\n```yaml\nkey: value\n```",
            proposal: "Ship it",
        })
        expect(parsed.problem).toBeUndefined()
    })

    test("preserves missing sections during partial updates", async () => {
        const fs = {
            readFile: mock(async (filePath: string) => {
                if (filePath === "/workspace/.agents/jobs/drafts/my_feature/plan.md") return "# Problems\n\nProblem text\n\n---\n\n# Requirements\n\n### Requirement One\nKeep this\n\n---\n\n# Constraints\n\nOld constraints\n\n---\n\n# Risks\n\n### Risk One\nKeep risk\n\n---\n\n# Proposal\n\nShip it\n"
                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            }),
            writeFile: mock(async () => { }),
            mkdir: mock(async () => undefined),
            rm: mock(async () => { }),
            stat: mock(async () => ({ mtimeMs: Date.now() })),
            rename: mock(async () => { }),
        }
        const client: OpencodeClient = {
            session: {
                get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                    data: { id: args.path.id, title: "My Feature" },
                })),
                update: mock(async (args: { path: { id: string }, query: { directory: string }, body: { title: string } }) => ({
                    data: { id: args.path.id, title: args.body.title },
                })),
            },
        } as unknown as OpencodeClient
        const tool = createAutocodePlanSaveTool(client, fs)

        const result = await executePlanSave(tool, { constraints: "### Constraint One\nChanged constraints" })

        expect(parseToolResult(result)).toEqual({
            job_name: "my_feature",
            job_path: "/workspace/.agents/jobs/drafts/my_feature/plan.md",
        })
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/my_feature/plan.md", "\n## Problems\n\nProblem text\n\n---\n\n## Impact\n\n\n\n---\n\n## Expectations\n\n\n\n---\n\n## Requirements\n\n### Requirement One\nKeep this\n\n---\n\n## Risks\n\n### Risk One\nKeep risk\n\n---\n\n## Constraints\n\n### Constraint One\nChanged constraints\n\n---\n\n## Proposal\n\nShip it\n")
    })

    test("strips major headings when saving proposal content", async () => {
        const fs = {
            readFile: mock(async (filePath: string) => {
                if (filePath === "/workspace/.agents/jobs/drafts/my_feature/plan.md") return "# Problems\n\nProblem text\n\n---\n\n# Requirements\n\n\n\n---\n\n# Constraints\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Proposal\n\nOld\n"
                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            }),
            writeFile: mock(async () => { }),
            mkdir: mock(async () => undefined),
            rm: mock(async () => { }),
            stat: mock(async () => ({ mtimeMs: Date.now() })),
            rename: mock(async () => { }),
        }
        const client: OpencodeClient = {
            session: {
                get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                    data: { id: args.path.id, title: "My Feature" },
                })),
                update: mock(async (args: { path: { id: string }, query: { directory: string }, body: { title: string } }) => ({
                    data: { id: args.path.id, title: args.body.title },
                })),
            },
        } as unknown as OpencodeClient
        const tool = createAutocodePlanSaveTool(client, fs)

        await executePlanSave(tool, { proposal: "## Proposed Solution\nShip it\n## Solution\nAgain" })

        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/my_feature/plan.md", expect.stringContaining("## Proposal\n\nShip it"))
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/drafts/my_feature/plan.md", expect.stringContaining("Again\n"))
    })

    test("returns retry response when plan.md is missing", async () => {
        const fs = {
            readFile: mock(async () => {
                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            }),
            writeFile: mock(async () => { }),
        }
        const tool = createAutocodePlanReadTool(fs)

        const result = await tool.execute({ job_name: "my_feature" }, createToolContext())

        expect(parseToolResult(result)).toMatchObject({
            failedAction: "read plan",
            error: "Plan not found for job: my_feature",
        })
    })

    test("reads plan.md from executing when the job has started", async () => {
        const fs = {
            readFile: mock(async (filePath: string) => {
                if (String(filePath).includes(".agents/jobs/drafts/")) {
                    const error = new Error("missing") as NodeJS.ErrnoException
                    error.code = "ENOENT"
                    throw error
                }

                if (filePath === "/workspace/.agents/jobs/executing/my_feature/plan.md") return "# Problems\n\nProblem in executing\n\n---\n\n# Requirements\n\n### Executing Requirement\n- req in executing\n\n---\n\n# Constraints\n\n### Executing Constraint\n- constraint in executing\n\n---\n\n# Risks\n\n### Executing Risk\nRisks in executing\n\n---\n\n# Proposal\n\nShip it in executing\n"

                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            }),
            writeFile: mock(async () => { }),
        }
        const tool = createAutocodePlanReadTool(fs)

        const result = await tool.execute({ job_name: "my_feature" }, createToolContext())

        expect(parseToolResult(result)).toMatchObject({
            file_path: ".agents/jobs/executing/my_feature/plan.md",
            problems: "Problem in executing",
            impact: "",
            expectations: "",
            requirements: "### Executing Requirement\n- req in executing",
            risks: "### Executing Risk\nRisks in executing",
            constraints: "### Executing Constraint\n- constraint in executing",
            proposal: "Ship it in executing",
        })
    })

    test("infers plan_read job_name from the current session title", async () => {
        const readdir: ReaddirWithFileTypes = async (dirPath, _opts) => dirPath === "/workspace/.agents/jobs/drafts"
            ? [createDirent("my_feature")]
            : []
        const fs = {
            readFile: mock(async (filePath: string) => {
                if (filePath === "/workspace/.agents/jobs/drafts/my_feature/plan.md") return "# Problems\n\nProblem text\n\n---\n\n# Impact\n\nImpact text\n\n---\n\n# Expectations\n\nExpectation text\n\n---\n\n# Requirements\n\n### Requirement\nKeep it\n\n---\n\n# Risks\n\n\n\n---\n\n# Constraints\n\n\n\n---\n\n# Proposal\n\nShip it\n"
                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            }),
            readdir: mock(readdir),
            writeFile: mock(async () => { }),
        }
        const client: OpencodeClient = {
            session: {
                get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                    data: { id: args.path.id, title: "My Feature" },
                })),
                update: mock(async (args: { path: { id: string }, query: { directory: string }, body: { title: string } }) => ({
                    data: { id: args.path.id, title: args.body.title },
                })),
            },
        } as unknown as OpencodeClient
        const tool = createAutocodePlanReadTool(client, fs)
        const parsed = parseToolResult(await tool.execute({}, createToolContext()))

        expect(parsed.job_name).toBe("my_feature")
        expect(parsed.file_path).toBe(".agents/jobs/drafts/my_feature/plan.md")
        expect(parsed.warning).toBeUndefined()
        expect((client as any).session.update).toHaveBeenCalledWith({
            path: { id: "session-1" },
            query: { directory: "/workspace" },
            body: { title: "My Feature" },
        })
    })

    test("reads plans from context.directory when worktree is filesystem root", async () => {
        const fs = {
            readFile: mock(async (filePath: string) => {
                if (filePath === "/workspace/fallback/.agents/jobs/drafts/my_feature/plan.md") return "# Problems\n\nProblem text\n\n---\n\n# Impact\n\n\n\n---\n\n# Expectations\n\n\n\n---\n\n# Requirements\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Constraints\n\n\n\n---\n\n# Proposal\n\nShip it\n"
                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            }),
            writeFile: mock(async () => { }),
        }
        const tool = createAutocodePlanReadTool(fs)

        const parsed = parseToolResult(await tool.execute({ job_name: "my_feature" }, {
            ...createToolContext(),
            directory: "/workspace/fallback",
            worktree: "/",
        }))

        expect(parsed).toEqual({
            job_name: "my_feature",
            file_path: ".agents/jobs/drafts/my_feature/plan.md",
            problems: "Problem text",
            impact: "",
            expectations: "",
            requirements: "",
            risks: "",
            constraints: "",
            proposal: "Ship it",
        })
    })

    test("returns retryable identity error when plan_read omission cannot be resolved", async () => {
        const readdir: ReaddirWithFileTypes = async () => []
        const fs = {
            readFile: mock(async () => {
                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            }),
            readdir: mock(readdir),
            writeFile: mock(async () => { }),
        }
        const client: OpencodeClient = {
            session: {
                get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                    data: { id: args.path.id, title: "Missing Job" },
                })),
            },
        } as unknown as OpencodeClient
        const tool = createAutocodePlanReadTool(client, fs)

        expect(parseToolResult(await tool.execute({}, createToolContext()))).toMatchObject({
            failedAction: "read plan",
            error: "No job_name was found for current session.",
        })
    })

    test("saves requirements, constraints and risks as raw markdown", async () => {
        const fs = {
            readFile: mock(async (filePath: string) => {
                if (filePath === "/workspace/.agents/jobs/drafts/my_feature/plan.md") return "# Problems\n\n\n\n---\n\n# Impact\n\n\n\n---\n\n# Expectations\n\n\n\n---\n\n# Requirements\n\n\n\n---\n\n# Risks\n\n\n\n---\n\n# Constraints\n\n\n\n---\n\n# Proposal\n\n"
                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            }),
            writeFile: mock(async (_filePath: string, _content: string) => { }),
            mkdir: mock(async () => undefined),
            rm: mock(async () => { }),
            stat: mock(async () => ({ mtimeMs: Date.now() })),
            rename: mock(async () => { }),
        }
        const client: OpencodeClient = {
            session: {
                get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                    data: { id: args.path.id, title: "My Feature" },
                })),
            },
        } as unknown as OpencodeClient
        const tool = createAutocodePlanSaveTool(client, fs)

        const functionalResult = await executePlanSave(tool, { requirements: "### First Requirement\n- list item\n> quote\n```json\n{ \"key\": \"value\" }\n```\n### Second Requirement\nAcceptance detail" })
        const constraintsResult = await executePlanSave(tool, { constraints: "### First Constraint\n```yaml\ncache: true\n```" })
        const riskResult = await executePlanSave(tool, { risks: "### Existing Risk\nMitigation details" })

        expect(parseToolResult(functionalResult)).toEqual({ job_name: "my_feature", job_path: "/workspace/.agents/jobs/drafts/my_feature/plan.md" })
        expect(parseToolResult(constraintsResult)).toEqual({ job_name: "my_feature", job_path: "/workspace/.agents/jobs/drafts/my_feature/plan.md" })
        expect(parseToolResult(riskResult)).toEqual({ job_name: "my_feature", job_path: "/workspace/.agents/jobs/drafts/my_feature/plan.md" })
        const planWrites = fs.writeFile.mock.calls.filter(([filePath]) => filePath === "/workspace/.agents/jobs/drafts/my_feature/plan.md")
        expect(planWrites[0]).toEqual(["/workspace/.agents/jobs/drafts/my_feature/plan.md", expect.stringContaining("### First Requirement\n- list item\n> quote\n```json\n{ \"key\": \"value\" }\n```\n### Second Requirement\nAcceptance detail")])
        expect(planWrites[1]).toEqual(["/workspace/.agents/jobs/drafts/my_feature/plan.md", expect.stringContaining("### First Constraint\n```yaml\ncache: true\n```")])
        expect(planWrites[2]).toEqual(["/workspace/.agents/jobs/drafts/my_feature/plan.md", expect.stringContaining("### Existing Risk\nMitigation details")])
    })
})

// ── loadAutocodeConfig unit tests ────────────────────────────────────────────

function makeFs(files: Record<string, string>): ConfigFileSystem {
    return {
        readFileSync(path: string) {
            if (path in files) return files[path]
            const err = new Error("ENOENT") as NodeJS.ErrnoException
            err.code = "ENOENT"
            throw err
        },
        ensureFileSync(path: string, contents: string) {
            if (!(path in files)) {
                files[path] = contents
            }
        },
    }
}

function globalAutocodeConfigPath() {
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "autocode.jsonc")
}

describe("loadAutocodeConfig", () => {
    test("no config returns empty tiers", async () => {
        const result = await loadAutocodeConfig("/wt", "/wt", makeFs({}))
        expect(result.tiers).toEqual({})
        expect(result.externalDirectories).toEqual({})
    })

    test("global-only config returns tiers", async () => {
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                autocode: { tiers: { fast: { model: "global-fast" }, smart: { model: "global-smart" } } },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)
        expect(result.tiers.fast?.model).toBe("global-fast")
        expect(result.tiers.smart?.model).toBe("global-smart")
    })

    test("global config respects XDG_CONFIG_HOME", async () => {
        const oldXdgConfigHome = process.env.XDG_CONFIG_HOME
        process.env.XDG_CONFIG_HOME = "/xdg-config"
        try {
            const fs = makeFs({
                "/xdg-config/opencode/autocode.jsonc": JSON.stringify({
                    autocode: { tiers: { fast: { model: "xdg-fast" } } },
                }),
            })

            const result = await loadAutocodeConfig("/wt", "/wt", fs)
            expect(result.tiers.fast?.model).toBe("xdg-fast")
        } finally {
            if (oldXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
            else process.env.XDG_CONFIG_HOME = oldXdgConfigHome
        }
    })

    test("local config overrides global tier values", async () => {
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                autocode: { tiers: { fast: { model: "global-fast" }, smart: { model: "global-smart" } } },
            }),
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: { tiers: { fast: { model: "local-fast" } } },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)
        expect(result.tiers.fast?.model).toBe("local-fast")
        expect(result.tiers.smart?.model).toBe("global-smart")
    })

    test("worktree and directory configs still override global in order", async () => {
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                autocode: { tiers: { fast: { model: "global-fast" }, balanced: { model: "global-balanced" }, smart: { model: "global-smart" } } },
            }),
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: { tiers: { fast: { model: "wt-fast" }, balanced: { model: "wt-balanced" } } },
            }),
            "/dir/.opencode/autocode.jsonc": JSON.stringify({
                autocode: { tiers: { fast: { model: "dir-fast" } } },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/dir", fs)
        expect(result.tiers.fast?.model).toBe("dir-fast")
        expect(result.tiers.balanced?.model).toBe("wt-balanced")
        expect(result.tiers.smart?.model).toBe("global-smart")
    })

    test("selected provider via tier and provider-keyed tiers", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tier: "openai",
                    tiers: {
                        openai: {
                            smart: { model: "openai/gpt-5.5", variant: "thinking" },
                            balanced: { model: "openai/gpt-5" },
                            fast: { model: "openai/gpt-5-mini" },
                        },
                        google: {
                            smart: { model: "google/gemini" },
                        },
                    },
                },
            }),
        })
        const result = await loadAutocodeConfig("/wt", "/wt", fs)
        expect(result.tiers.smart).toEqual({ model: "openai/gpt-5.5", variant: "thinking" })
        expect(result.tiers.balanced).toEqual({ model: "openai/gpt-5" })
        expect(result.tiers.fast).toEqual({ model: "openai/gpt-5-mini" })
    })

    test("provider-selected cheap tier config is parsed", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tier: "openai",
                    tiers: {
                        openai: {
                            cheap: { model: "openai/gpt-5-nano", variant: "economy" },
                            smart: { model: "openai/gpt-5.5", variant: "thinking" },
                            balanced: { model: "openai/gpt-5" },
                            fast: { model: "openai/gpt-5-mini" },
                        },
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.tiers.cheap).toEqual({ model: "openai/gpt-5-nano", variant: "economy" })
        expect(result.tiers.smart).toEqual({ model: "openai/gpt-5.5", variant: "thinking" })
        expect(result.tiers.fast).toEqual({ model: "openai/gpt-5-mini" })
    })

    test("missing or non-string tier falls back to direct tiers", async () => {
        const missingTierFs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tiers: { balanced: { model: "missing-tier-direct" }, openai: { balanced: { model: "provider-model" } } },
                },
            }),
        })
        const nonStringTierFs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tier: 1,
                    tiers: { balanced: { model: "non-string-tier-direct" }, openai: { balanced: { model: "provider-model" } } },
                },
            }),
        })

        const missingTierResult = await loadAutocodeConfig("/wt", "/wt", missingTierFs)
        const nonStringTierResult = await loadAutocodeConfig("/wt", "/wt", nonStringTierFs)
        expect(missingTierResult.tiers.balanced?.model).toBe("missing-tier-direct")
        expect(nonStringTierResult.tiers.balanced?.model).toBe("non-string-tier-direct")
    })

    test("unknown or invalid selected provider falls back to direct tiers", async () => {
        const unknownProviderFs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tier: "missing",
                    tiers: { fast: { model: "unknown-direct" }, openai: { fast: { model: "provider-model" } } },
                },
            }),
        })
        const invalidProviderFs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tier: "openai",
                    tiers: { smart: { model: "invalid-direct" }, openai: { default: { model: "provider-model" } } },
                },
            }),
        })

        const unknownProviderResult = await loadAutocodeConfig("/wt", "/wt", unknownProviderFs)
        const invalidProviderResult = await loadAutocodeConfig("/wt", "/wt", invalidProviderFs)
        expect(unknownProviderResult.tiers.fast?.model).toBe("unknown-direct")
        expect(invalidProviderResult.tiers.smart?.model).toBe("invalid-direct")
    })

    test("directory override with provider-selected tiers", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tier: "openai",
                    tiers: {
                        openai: { fast: { model: "wt-fast" }, smart: { model: "wt-smart" } },
                    },
                },
            }),
            "/dir/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tier: "google",
                    tiers: {
                        google: { fast: { model: "dir-fast" } },
                    },
                },
            }),
        })
        const result = await loadAutocodeConfig("/wt", "/dir", fs)
        expect(result.tiers.fast?.model).toBe("dir-fast")
        expect(result.tiers.smart?.model).toBe("wt-smart")
    })

    test("local tier selection can reuse broader tier definitions", async () => {
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                autocode: {
                    tiers: {
                        openai: {
                            fast: { model: "global-fast" },
                            smart: { model: "global-smart" },
                        },
                        anthropic: {
                            fast: { model: "unused-fast" },
                        },
                    },
                },
            }),
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tier: "openai",
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.tiers.fast).toEqual({ model: "global-fast" })
        expect(result.tiers.smart).toEqual({ model: "global-smart" })
    })

    test("direct tiers compatibility still works", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tiers: {
                        smart: { model: "anthropic/claude-opus-4-5", variant: "thinking" },
                        balanced: { model: "anthropic/claude-sonnet-4-5" },
                        fast: { model: "anthropic/claude-haiku-4-5" },
                    },
                },
            }),
        })
        const result = await loadAutocodeConfig("/wt", "/wt", fs)
        expect(result.tiers.smart).toEqual({ model: "anthropic/claude-opus-4-5", variant: "thinking" })
        expect(result.tiers.balanced).toEqual({ model: "anthropic/claude-sonnet-4-5" })
        expect(result.tiers.fast).toEqual({ model: "anthropic/claude-haiku-4-5" })
    })

    test("direct tier-map cheap config is parsed", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tiers: {
                        cheap: { model: "openai/gpt-5-nano", variant: "economy" },
                        smart: { model: "anthropic/claude-opus-4-5", variant: "thinking" },
                        balanced: { model: "anthropic/claude-sonnet-4-5" },
                        fast: { model: "anthropic/claude-haiku-4-5" },
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.tiers.cheap).toEqual({ model: "openai/gpt-5-nano", variant: "economy" })
        expect(result.tiers.smart).toEqual({ model: "anthropic/claude-opus-4-5", variant: "thinking" })
        expect(result.tiers.balanced).toEqual({ model: "anthropic/claude-sonnet-4-5" })
        expect(result.tiers.fast).toEqual({ model: "anthropic/claude-haiku-4-5" })
    })

    test("legacy shape: reads model and variant from model/variant maps", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    model: {
                        smart: "openai/gpt-4o",
                        fast: "openai/gpt-4o-mini",
                    },
                    variant: {
                        smart: "extended",
                    },
                },
            }),
        })
        const result = await loadAutocodeConfig("/wt", "/wt", fs)
        expect(result.tiers.smart).toEqual({ model: "openai/gpt-4o", variant: "extended" })
        expect(result.tiers.fast).toEqual({ model: "openai/gpt-4o-mini", variant: undefined })
        expect(result.tiers.balanced).toBeUndefined()
    })

    test("legacy model.cheap / variant.cheap is parsed", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    model: {
                        cheap: "openai/gpt-5-nano",
                        smart: "openai/gpt-4o",
                        fast: "openai/gpt-4o-mini",
                    },
                    variant: {
                        cheap: "economy",
                        smart: "extended",
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.tiers.cheap).toEqual({ model: "openai/gpt-5-nano", variant: "economy" })
        expect(result.tiers.smart).toEqual({ model: "openai/gpt-4o", variant: "extended" })
        expect(result.tiers.fast).toEqual({ model: "openai/gpt-4o-mini", variant: undefined })
    })

    test("directory overrides worktree for same tier", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({ autocode: { tiers: { fast: { model: "wt-model" } } } }),
            "/dir/.opencode/autocode.jsonc": JSON.stringify({ autocode: { tiers: { fast: { model: "dir-model" } } } }),
        })
        const result = await loadAutocodeConfig("/wt", "/dir", fs)
        expect(result.tiers.fast?.model).toBe("dir-model")
    })

    test("malformed JSONC throws with path and message", async () => {
        const fs = makeFs({ "/wt/.opencode/autocode.jsonc": "{ bad json }" })
        await expect(loadAutocodeConfig("/wt", "/wt", fs)).rejects.toThrow(
            /autocode: malformed JSONC in .*autocode\.jsonc/
        )
    })

    test("JSONC comments are stripped before parsing", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": `{
                // global model settings
                "autocode": {
                    "tiers": {
                        /* smart tier */ "smart": { "model": "anthropic/claude-opus-4-5" },
                    },
                },
            }`,
        })
        const result = await loadAutocodeConfig("/wt", "/wt", fs)
        expect(result.tiers.smart?.model).toBe("anthropic/claude-opus-4-5")
    })
})

// ── plugin.config end-to-end tier tests ──────────────────────────────────────

describe("plugin.config tier wiring", () => {
    function createTierClient(): OpencodeClient {
        return {
            session: {
                async get() { return { data: createSession("session-1", "/workspace") } },
                async children() { return { data: [] } },
                async messages() { return { data: [] } },
                async promptAsync() { return {} },
            },
            path: {
                async get() { throw new Error("no path") },
            },
            tui: { async showToast() { return { data: true } } },
        } as unknown as OpencodeClient
    }

    function writeAutocodeTierConfig(worktree: string, autocodeConfig: Record<string, unknown>): void {
        mkdirSync(join(worktree, ".opencode"), { recursive: true })
        writeFileSync(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({ autocode: autocodeConfig }))
    }

    test("default (no config) leaves model and variant unset; no tier on agents", async () => {
        await withIsolatedConfigHome(async () => {
            const worktree = mkdtempSync(join(tmpdir(), "autocode-test-"))
            try {
                const plugin = await autocode(createPluginInput(createTierClient(), worktree))
                const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }
                await configurePlugin(plugin, cfg)

                expect(getAgentField(cfg, "assist", "model")).toBeUndefined()
                expect(getAgentField(cfg, "assist", "variant")).toBeUndefined()
                expect(getAgentField(cfg, "assist", "tier")).toBeUndefined()
            } finally {
                rmSync(worktree, { recursive: true, force: true })
            }
        })
    })

    test("user override wins over tier mapping", async () => {
        const worktree = mkdtempSync(join(tmpdir(), "autocode-test-"))
        try {
            mkdirSync(join(worktree, ".opencode"), { recursive: true })
            writeFileSync(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({
                autocode: { tiers: { smart: { model: "anthropic/claude-opus-4-5" } } },
            }))

            const plugin = await autocode(createPluginInput(createTierClient(), worktree))
            const cfg: ConfigWithRuntimeSections = { agent: { assist: { model: "user/custom-model" } }, command: {} }
            await configurePlugin(plugin, cfg)

            expect(getAgentField(cfg, "assist", "model")).toBe("user/custom-model")
        } finally {
            rmSync(worktree, { recursive: true, force: true })
        }
    })

    test("cheap tier config populates runtime generation, compaction, and preserves existing tier mappings", async () => {
        await withIsolatedConfigHome(async () => {
            const worktree = mkdtempSync(join(tmpdir(), "autocode-test-"))
            try {
                writeAutocodeTierConfig(worktree, {
                    tiers: {
                        cheap: { model: "openai/gpt-5-nano", variant: "economy" },
                        smart: { model: "anthropic/claude-opus-4-5", variant: "thinking" },
                        balanced: { model: "anthropic/claude-sonnet-4-5", variant: "standard" },
                        fast: { model: "anthropic/claude-haiku-4-5", variant: "quick" },
                    },
                })

                const plugin = await autocode(createPluginInput(createTierClient(), worktree))
                const cfg: ConfigWithRuntimeSections & { small_model?: string } = { agent: {}, command: {} }

                await configurePlugin(plugin, cfg)

                expect(cfg.small_model).toBe("openai/gpt-5-nano")
                expect(getAgentField(cfg, "auto_general", "model")).toBe("anthropic/claude-opus-4-5")
                expect(getAgentField(cfg, "auto_general", "variant")).toBe("thinking")
                expect(getAgentField(cfg, "compaction", "model")).toBe("openai/gpt-5-nano")
                expect(getAgentField(cfg, "compaction", "variant")).toBe("economy")
                expect(getAgentField(cfg, "design", "model")).toBe("anthropic/claude-opus-4-5")
                expect(getAgentField(cfg, "design", "variant")).toBe("thinking")
                expect(getAgentField(cfg, "auto", "model")).toBe("anthropic/claude-opus-4-5")
                expect(getAgentField(cfg, "research", "model")).toBe("anthropic/claude-opus-4-5")
                expect(getAgentField(cfg, "execute_code", "model")).toBe("anthropic/claude-sonnet-4-5")
                expect(getAgentField(cfg, "execute_code", "variant")).toBe("standard")
                expect(getAgentField(cfg, "query_git", "model")).toBe("anthropic/claude-haiku-4-5")
                expect(getAgentField(cfg, "query_git", "variant")).toBe("quick")
                expect(getAgentField(cfg, "general", "tier")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "tier")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "prompt")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "permission")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "mode")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "description")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "tools")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "instructions")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "behavior")).toBeUndefined()
                expect(getAgentField(cfg, "design", "tier")).toBeUndefined()
                expect(getAgentField(cfg, "research", "tier")).toBeUndefined()
                expect(getAgentField(cfg, "auto", "tier")).toBeUndefined()
                expect(getAgentField(cfg, "execute_code", "tier")).toBeUndefined()
                expect(getAgentField(cfg, "query_git", "tier")).toBeUndefined()
                expect(cfg.agent.title).toBeUndefined()
            } finally {
                rmSync(worktree, { recursive: true, force: true })
            }
        })
    })

    test("missing cheap tier leaves small_model unset", async () => {
        await withIsolatedConfigHome(async () => {
            const worktree = mkdtempSync(join(tmpdir(), "autocode-test-"))
            try {
                writeAutocodeTierConfig(worktree, {
                    tiers: {
                        smart: { model: "anthropic/claude-opus-4-5" },
                        balanced: { model: "anthropic/claude-sonnet-4-5" },
                        fast: { model: "anthropic/claude-haiku-4-5" },
                    },
                })

                const plugin = await autocode(createPluginInput(createTierClient(), worktree))
                const cfg: ConfigWithRuntimeSections & { small_model?: string } = { agent: {}, command: {} }

                await configurePlugin(plugin, cfg)

                expect(cfg.small_model).toBeUndefined()
                expect(getAgentField(cfg, "design", "model")).toBe("anthropic/claude-opus-4-5")
                expect(getAgentField(cfg, "auto", "model")).toBe("anthropic/claude-opus-4-5")
                expect(getAgentField(cfg, "research", "model")).toBe("anthropic/claude-opus-4-5")
                expect(getAgentField(cfg, "execute_code", "model")).toBe("anthropic/claude-sonnet-4-5")
                expect(getAgentField(cfg, "query_git", "model")).toBe("anthropic/claude-haiku-4-5")
            } finally {
                rmSync(worktree, { recursive: true, force: true })
            }
        })
    })

    test("explicit small_model is preserved when cheap tier is configured", async () => {
        await withIsolatedConfigHome(async () => {
            const worktree = mkdtempSync(join(tmpdir(), "autocode-test-"))
            try {
                writeAutocodeTierConfig(worktree, {
                    tiers: {
                        cheap: { model: "openai/gpt-5-nano", variant: "economy" },
                        smart: { model: "anthropic/claude-opus-4-5" },
                        balanced: { model: "anthropic/claude-sonnet-4-5" },
                        fast: { model: "anthropic/claude-haiku-4-5" },
                    },
                })

                const plugin = await autocode(createPluginInput(createTierClient(), worktree))
                const cfg: ConfigWithRuntimeSections & { small_model?: string } = {
                    agent: {},
                    command: {},
                    small_model: "user/small-model",
                }

                await configurePlugin(plugin, cfg)

                expect(cfg.small_model).toBe("user/small-model")
            } finally {
                rmSync(worktree, { recursive: true, force: true })
            }
        })
    })

    test("explicit cfg.agent.title is not overwritten when cheap tier is configured", async () => {
        await withIsolatedConfigHome(async () => {
            const worktree = mkdtempSync(join(tmpdir(), "autocode-test-"))
            try {
                writeAutocodeTierConfig(worktree, {
                    tiers: {
                        cheap: { model: "openai/gpt-5-nano", variant: "economy" },
                        smart: { model: "anthropic/claude-opus-4-5" },
                        balanced: { model: "anthropic/claude-sonnet-4-5" },
                        fast: { model: "anthropic/claude-haiku-4-5" },
                    },
                })

                const titleAgent = { model: "user/title-model", prompt: "Keep title agent" }
                const plugin = await autocode(createPluginInput(createTierClient(), worktree))
                const cfg = { agent: { title: titleAgent }, command: {} } satisfies ConfigWithRuntimeSections

                await configurePlugin(plugin, cfg)

                expect(cfg.agent.title).toBe(titleAgent)
                expect(cfg.agent.title).toEqual({ model: "user/title-model", prompt: "Keep title agent" })
            } finally {
                rmSync(worktree, { recursive: true, force: true })
            }
        })
    })

    test("explicit general agent model and variant override smart tier defaults", async () => {
        await withIsolatedConfigHome(async () => {
            const worktree = mkdtempSync(join(tmpdir(), "autocode-test-"))
            try {
                writeAutocodeTierConfig(worktree, {
                    tiers: {
                        cheap: { model: "openai/gpt-5-nano", variant: "economy" },
                        smart: { model: "anthropic/claude-opus-4-5" },
                        balanced: { model: "anthropic/claude-sonnet-4-5" },
                        fast: { model: "anthropic/claude-haiku-4-5" },
                    },
                })

                const plugin = await autocode(createPluginInput(createTierClient(), worktree))
                const cfg = {
                    agent: {
                        general: {
                            model: "user/general-model",
                            variant: "user-variant",
                        },
                    },
                    command: {},
                } satisfies ConfigWithRuntimeSections

                await configurePlugin(plugin, cfg)

                expect(getAgentField(cfg, "general", "model")).toBe("user/general-model")
                expect(getAgentField(cfg, "general", "variant")).toBe("user-variant")
            } finally {
                rmSync(worktree, { recursive: true, force: true })
            }
        })
    })

    test("explicit compaction agent model overrides cheap tier model", async () => {
        await withIsolatedConfigHome(async () => {
            const worktree = mkdtempSync(join(tmpdir(), "autocode-test-"))
            try {
                writeAutocodeTierConfig(worktree, {
                    tiers: {
                        cheap: { model: "openai/gpt-5-nano", variant: "economy" },
                        smart: { model: "anthropic/claude-opus-4-5" },
                        balanced: { model: "anthropic/claude-sonnet-4-5" },
                        fast: { model: "anthropic/claude-haiku-4-5" },
                    },
                })

                const plugin = await autocode(createPluginInput(createTierClient(), worktree))
                const cfg = {
                    agent: {
                        compaction: {
                            model: "user/compaction-model",
                        },
                    },
                    command: {},
                } satisfies ConfigWithRuntimeSections

                await configurePlugin(plugin, cfg)

                expect(getAgentField(cfg, "compaction", "model")).toBe("user/compaction-model")
                expect(getAgentField(cfg, "compaction", "variant")).toBe("economy")
                expect(getAgentField(cfg, "compaction", "tier")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "prompt")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "permission")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "mode")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "description")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "tools")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "instructions")).toBeUndefined()
                expect(getAgentField(cfg, "compaction", "behavior")).toBeUndefined()
            } finally {
                rmSync(worktree, { recursive: true, force: true })
            }
        })
    })
})
