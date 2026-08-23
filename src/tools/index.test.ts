import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import type { Dirent } from "node:fs"
import type { Config as PluginConfig, Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Session, OpencodeClient, SessionGetData, SessionChildrenData, SessionPromptAsyncData } from "@opencode-ai/sdk"
import autocode from "../plugin"
import { loadAutocodeConfig } from "@/config"
import type { ConfigFileSystem } from "@/config"
import { createAutocodeConceptReadTool } from "./autocode_concept_read"
import { createAutocodeConceptListTool } from "./autocode_concept_list"
import { createAutocodeConceptCreateTool } from "./autocode_concept_create"
import { createTaskResumeTool } from "./task_resume"
import { createAutocodeLogoFindTool } from "./autocode_logo_find"
import { createAbortResponse, createErrorResponse } from "@/utils/tools"
import { applySandboxPlatformPolicy } from "@/agents"
import { createTools } from "./index"
import { createToolContext } from "./test_context"
import type { SandboxPlatformSupportOptions } from "@/utils/sandbox"

const PROMPT_TASK_RESUME = "You have been interrupted, therefore you MUST:\n\n1. For each previous `task` call that were interrupted (no output when due):\n    - Call `task_resume` tool with same `task_id` used in previous `task` call.\n2. Then resume your own work"
const PROMPT_WORK_RESUME = "Resume"
const sandboxToolNames = ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy", "autocode_sandbox_config_edit", "autocode_sandbox_config_read", "autocode_sandbox_config_remove"]

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

function createDirent(name: string, type: MockDirentType = "directory"): Dirent {
    return {
        name,
        isDirectory: () => type === "directory",
        isFile: () => type === "file",
    } as Dirent
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

type ToolSurface = {
    args?: Record<string, {
        def?: { innerType?: { description?: string } }
        description?: string
        unwrap?: () => { description?: string }
    }>
    description?: string
}

function toolSurfaceText(tool: unknown) {
    const surface = tool as ToolSurface
    const argDescriptions = Object.values(surface.args ?? {}).map((arg) => arg.description ?? arg.unwrap?.().description ?? arg.def?.innerType?.description ?? "")
    return [surface.description ?? "", ...argDescriptions].join("\n")
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
        await withIsolatedConfigHome(async () => {
            const previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
            try {
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
            } finally {
                if (previousSkipBootstrap === undefined) {
                    delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
                } else {
                    process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
                }
            }
        })
    })

    test("registers job-design command for the design agent", async () => {
        await withIsolatedConfigHome(async () => {
            const previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
            try {
                const plugin = await autocode(createPluginInput(createMockClient()))
                const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

                await configurePlugin(plugin, cfg)

                expect(cfg.command["job-design"]?.agent).toBe("design")
                expect(cfg.command["job-design"]?.template).toContain("autocode_concept_list")
            } finally {
                if (previousSkipBootstrap === undefined) {
                    delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
                } else {
                    process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
                }
            }
        })
    })

    test("allows assist to call dependency checks", async () => {
        await withIsolatedConfigHome(async () => {
            const previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
            try {
                const plugin = await autocode(createPluginInput(createMockClient()))
                const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

                await configurePlugin(plugin, cfg)

                expect(getPermissionRule(cfg.agent.execute_document?.permission, "autocode_dependencies")).toBeUndefined()
            } finally {
                if (previousSkipBootstrap === undefined) {
                    delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
                } else {
                    process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
                }
            }
        })
    })

    test("applies native external_directory rules before agent-specific fallback", async () => {
        await withIsolatedConfigHome(async () => {
            const previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
            try {
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
            } finally {
                if (previousSkipBootstrap === undefined) {
                    delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
                } else {
                    process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
                }
            }
        })
    })

    test("registers job-execute command for planned autonomous execution", async () => {
        await withIsolatedConfigHome(async () => {
            const previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
            try {
                const plugin = await autocode(createPluginInput(createMockClient()))
                const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

                await configurePlugin(plugin, cfg)

                expect(cfg.command["job-execute"]?.agent).toBe("design")
                expect(cfg.command["job-execute"]?.template).toContain("autocode_job_execute")
                expect(cfg.command["job-execute"]?.template).toContain("`agent` = `auto`")
                expect(cfg.command["job-execute"]?.template).toContain("workspace_required")
                expect(cfg.command["job-execute"]?.template).not.toContain("list_plans")
                expect(cfg.command["job-execute"]?.template).not.toContain("result_type == \"workflow\"")
            } finally {
                if (previousSkipBootstrap === undefined) {
                    delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
                } else {
                    process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
                }
            }
        })
    })

    test("registers job-facilitate command for planned facilitated execution", async () => {
        await withIsolatedConfigHome(async () => {
            const previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
            try {
                const plugin = await autocode(createPluginInput(createMockClient()))
                const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

                await configurePlugin(plugin, cfg)

                expect(cfg.command["job-facilitate"]?.agent).toBe("design")
                expect(cfg.command["job-facilitate"]?.description).toBe("Start assisted execution in a new session.")
                expect(cfg.command["job-facilitate"]?.template).toContain("autocode_job_execute")
                expect(cfg.command["job-facilitate"]?.template).toContain("`agent` = `assist`")
                expect(cfg.command["job-facilitate"]?.template).toContain("workspace_required")
                expect(cfg.command["job-facilitate"]?.template).not.toContain("list_plans")
                expect(cfg.command["job-facilitate"]?.template).not.toContain("result_type == \"workflow\"")
            } finally {
                if (previousSkipBootstrap === undefined) {
                    delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
                } else {
                    process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
                }
            }
        })
    })

    test("registers job-execute command as autonomous execution", async () => {
        await withIsolatedConfigHome(async () => {
            const previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
            try {
                const plugin = await autocode(createPluginInput(createMockClient()))
                const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

                await configurePlugin(plugin, cfg)

                expect(cfg.command["job-execute"]?.agent).toBe("design")
                expect(cfg.command["job-execute"]?.subtask).toBe(false)
                expect(cfg.command["job-execute"]?.template).toContain("autocode_job_execute")
                expect(cfg.command["job-execute"]?.template).toContain("`agent` = `auto`")
            } finally {
                if (previousSkipBootstrap === undefined) {
                    delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
                } else {
                    process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
                }
            }
        })
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
        const skillLearn = tools.skill_learn as unknown as { description: string, args: Record<string, unknown> }
        const skill = tools.skill as unknown as { description: string, args: Record<string, unknown> }

        expect(Object.keys(tools)).toEqual(expect.arrayContaining(["autocode_dependencies", "autocode_kill", "autocode_rest", "autocode_config_read", "autocode_config_edit",             "autocode_config_remove", "autocode_md_create", "autocode_md_h1", "autocode_md_read", "autocode_md_remove", "autocode_md_update", "autocode_md_frontmatter_read", "autocode_md_frontmatter_edit", "autocode_ssh_config_read", "autocode_ssh_config_edit", "autocode_ssh_config_remove", "autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy", "skill_learn", "skill", "git_status", "git_diff_unstaged", "git_diff_staged", "git_diff", "git_log", "git_show", "git_add", "git_commit", "git_reset", "git_create_branch", "git_checkout", "git_branch"]))
        expect(tools.skill).toBeDefined()
        expect(Object.keys((tools.autocode_dependencies as unknown as { args: Record<string, unknown> }).args)).toEqual([])
        expect(Object.keys(tools)).not.toContain("autocode_sandbox_list")
        expect(sandboxCreate.description).toContain("Create")
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
        expect(Object.keys(skillLearn.args)).toEqual(["category", "name", "content", "description", "key", "references"])
        expect(skill.description).toContain("skill")
        expect(Object.keys(skill.args)).toEqual(["name", "reference"])
        expect(Object.keys(skill.args)).not.toContain("subjects")
    })

    test("createTools registers exact managed script tool set", () => {
        const tools = createTools(createMockClient())
        const scriptToolNames = Object.keys(tools).filter((toolName) => toolName.startsWith("autocode_script_"))

        expect(scriptToolNames).toEqual([
            "autocode_script_install",
            "autocode_script_project",
            "autocode_script_run",
            "autocode_script_service",
        ])
    })

    test("createTools omits every sandbox tool on Windows", () => {
        const tools = createTools(createMockClient(), {}, undefined, { isWindows: true })

        for (const toolName of sandboxToolNames) {
            expect(tools).not.toHaveProperty(toolName)
        }
        expect(Object.keys(tools).filter((toolName) => toolName.startsWith("autocode_sandbox_"))).toEqual([])
    })

    test("createTools keeps every sandbox tool on Linux", () => {
        const tools = createTools(createMockClient(), {}, undefined, { isWindows: false })

        expect(Object.keys(tools)).toEqual(expect.arrayContaining(sandboxToolNames))
    })

    test("createTools exposes remote SSH file suite tools", () => {
        const tools = createTools(createMockClient())

        expect(Object.keys(tools)).toEqual(expect.arrayContaining([
            "autocode_ssh_config_read",
            "autocode_ssh_config_edit",
            "autocode_ssh_config_remove",
            "autocode_ssh_glob",
            "autocode_ssh_grep_file",
            "autocode_ssh_patch_file",
            "autocode_ssh_edit_file",
            "autocode_ssh_write_file",
        ]))
        expect(Object.keys((tools.autocode_ssh_glob as unknown as { args: Record<string, unknown> }).args)).toEqual(["ssh_key", "pattern", "path", "limit"])
        expect(Object.keys((tools.autocode_ssh_grep_file as unknown as { args: Record<string, unknown> }).args)).toEqual(["ssh_key", "pattern", "path", "include", "limit"])
        expect(Object.keys((tools.autocode_ssh_patch_file as unknown as { args: Record<string, unknown> }).args)).toEqual(["ssh_key", "path", "patch"])
        expect(Object.keys((tools.autocode_ssh_edit_file as unknown as { args: Record<string, unknown> }).args)).toEqual(["ssh_key", "path", "oldString", "newString", "replaceAll"])
        expect(Object.keys((tools.autocode_ssh_write_file as unknown as { args: Record<string, unknown> }).args)).toEqual(["ssh_key", "path", "content", "create_dirs"])
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
        await withIsolatedConfigHome(async () => {
            const previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
            try {
                const plugin = await autocode(createPluginInput(createMockClient()))
                const cfg: ConfigWithRuntimeSections = { agent: {}, command: {} }

                await configurePlugin(plugin, cfg)

                expect(cfg.command["git-conflict"]?.agent).toBe("assist_git_conflict")
            } finally {
                if (previousSkipBootstrap === undefined) {
                    delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
                } else {
                    process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
                }
            }
        })
    })

    test("omits removed legacy public tool names from injected prompts", async () => {
        await withIsolatedConfigHome(async () => {
            const previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
            try {
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
            } finally {
                if (previousSkipBootstrap === undefined) {
                    delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
                } else {
                    process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
                }
            }
        })
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
        await withIsolatedConfigHome(async () => {
            const previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
            try {
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
            } finally {
                if (previousSkipBootstrap === undefined) {
                    delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
                } else {
                    process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
                }
            }
        })
    })

    test("returns sorted backlog JSON with names and first non-heading text descriptions after optional front-matter", async () => {
        const reads: string[] = []
        const tool = createAutocodeConceptListTool({
            async readdir(filePath: string, _options: { withFileTypes: true }): Promise<Dirent[]> {
                if (!String(filePath).endsWith("/concepts")) return []
                return [
                    createDirent("zeta.md", "file"),
                    createDirent("notes.txt", "file"),
                    createDirent("alpha.md", "file"),
                    createDirent("nested"),
                    createDirent("plain.md", "file"),
                ]
            },
            async readFile(filePath: string, _encoding: "utf8"): Promise<string> {
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
            "/workspace/.agents/concepts/alpha.md",
            "/workspace/.agents/concepts/plain.md",
            "/workspace/.agents/concepts/zeta.md",
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

    test("lists only available concept files", async () => {
        const tool = createAutocodeConceptListTool({
            async readdir(filePath: string, _options: { withFileTypes: true }): Promise<Dirent[]> {
                const directory = String(filePath)
                if (directory.endsWith("/.agents/concepts")) return [createDirent("idea.md", "file")]
                return []
            },
            async readFile(filePath: string, _encoding: "utf8"): Promise<string> {
                return `Description for ${String(filePath).split("/").at(-2)}`
            },
        })

        const result = await tool.execute({}, createToolContext())

        expect(parseToolResult(result)).toEqual({
            backlog: [
                { label: "idea", description: "Description for concepts" },
            ],
        })
    })
})

describe("autocode_concept_read tool", () => {
    test("registers the tool on the plugin with design concept-read permission", async () => {
        await withIsolatedConfigHome(async () => {
            const previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
            try {
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
            } finally {
                if (previousSkipBootstrap === undefined) {
                    delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
                } else {
                    process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
                }
            }
        })
    })

    test("omits one leading front-matter block without moving the concept", async () => {
        const reads: string[] = []
        const tool = createAutocodeConceptReadTool({
            async readFile(filePath: string, _encoding: "utf8"): Promise<string> {
                reads.push(String(filePath))
                return "---\nsource session title: \"Session\"\nsource directory: \"/workspace\"\ncreate: \"2026-06-02 10:11:12\"\nconcept title: \"Item Title\"\n---\n\n# Item Title\n\nRaw body\n---\nKeep separator\n"
            },
        })

        const result = await tool.execute({ label: "example-item" }, createToolContext())

        expect(result).toBe("# Item Title\n\nRaw body\n---\nKeep separator\n")
        expect(reads).toEqual([
            "/workspace/.agents/concepts/example-item.md",
        ])
    })

    test("rejects portable concept path escapes before file operations", async () => {
        const readFile = mock(async (_filePath: string, _encoding: "utf8") => "# Outside concept")
        const tool = createAutocodeConceptReadTool({ readFile })

        for (const label of [
            ".",
            "..",
            "../outside",
            "..\\outside",
            "/outside",
            "C:\\outside",
            "C:outside",
            "\\\\server\\share\\outside",
            "../concepts-sibling/outside",
        ]) {
            await tool.execute({ label }, createToolContext())
        }

        expect(readFile).not.toHaveBeenCalled()
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
            file_path: ".agents/concepts/checkout_flow.md",
        })
        expect(writes).toEqual([{
            filePath: "/workspace/.agents/concepts/checkout_flow.md",
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
            file_path: ".agents/concepts/checkout_flow.md",
        })
        expect(writes).toEqual([{
            filePath: "/workspace/fallback/.agents/concepts/checkout_flow.md",
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

describe("tool registrations", () => {
    test("registers design tools and grants design permission", async () => {
        await withIsolatedConfigHome(async () => {
            const previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
            try {
                const client = createMockClient()
                const plugin = await autocode(createPluginInput(client))
                const cfg = createConfig()
                await configurePlugin(plugin, cfg)
                expect(Object.keys(plugin.tool ?? {}).sort()).toEqual([
                    "autocode_agent_execute",
                    "autocode_concept_create",
                    "autocode_concept_list",
                    "autocode_concept_read",
                    "autocode_config_read",
                    "autocode_config_edit",
                    "autocode_config_remove",
                    "autocode_md_create",
                    "autocode_md_h1",
                    "autocode_md_read",
                    "autocode_md_remove",
                    "autocode_md_update",
                    "autocode_md_frontmatter_read",
                    "autocode_md_frontmatter_edit",
                    "autocode_process_kill",
                    "autocode_db_table",
                    "autocode_db_table_read",
                    "autocode_db_tables",
                    "autocode_job_execute",
                    "autocode_job_list",
                    "autocode_kill",
                    "autocode_logo_find",
                    "autocode_db_schemas",
                    "autocode_dependencies",
                    "autocode_rest",
                    "autocode_sandbox_cli",
                    "autocode_sandbox_config_edit",
                    "autocode_sandbox_config_read",
                    "autocode_sandbox_config_remove",
                    "autocode_sandbox_copy",
                    "autocode_sandbox_create",
                    "autocode_sandbox_delete",
                    "autocode_sandbox_edit",
                    "autocode_sandbox_glob",
                    "autocode_sandbox_grep",
                    "autocode_sandbox_read",
                    "autocode_script_install",
                    "autocode_script_project",
                    "autocode_script_run",
                    "autocode_script_service",
                    "autocode_session_context",
                    "autocode_session_create",
                    "skill_edit",
                    "autocode_ssh_command",
                    "autocode_ssh_config_read",
                    "autocode_ssh_config_edit",
                    "autocode_ssh_config_remove",
                    "autocode_ssh_edit_file",
                    "autocode_ssh_glob",
                    "autocode_ssh_grep_file",
                    "autocode_ssh_list",
                    "autocode_ssh_patch_file",
                    "autocode_ssh_read_attributes",
                    "autocode_ssh_read_file",
                    "autocode_ssh_write_attributes",
                    "autocode_ssh_write_file",
                    "skill_learn",
                    "skill_read",
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
                expect(plugin.tool?.autocode_job_draft).toBeUndefined()
                expect(plugin.tool?.autocode_plan_read).toBeUndefined()
                expect(plugin.tool?.autocode_plan_load_problem).toBeUndefined()
                expect(plugin.tool?.autocode_plan_load_risks).toBeUndefined()
                expect(plugin.tool?.autocode_draft_job_read).toBeUndefined()
                expect(plugin.tool?.autocode_job_list).toBeDefined()
                expect(plugin.tool?.autocode_logo_find).toBeDefined()
                expect(plugin.tool?.autocode_logo).toBeUndefined()
                expect(toolSurfaceText(plugin.tool?.autocode_job_list)).toContain("List timestamped job workspaces.")
                expect(plugin.tool?.autocode_act_prompt).toBeUndefined()
                expect(plugin.tool?.autocode_act).toBeUndefined()
                expect(plugin.tool?.autocode_agent_execute).toBeDefined()
                expect(plugin.tool?.autocode_session_context).toBeDefined()
                expect(toolSurfaceText(plugin.tool?.autocode_session_context)).toContain("Read sanitized current session context and token usage metadata.")
                expect(plugin.tool?.autocode_session_create).toBeDefined()
                expect(plugin.tool?.skill_learn).toBeDefined()
                expect(plugin.tool?.skill).toBeDefined()
                expect(toolSurfaceText(plugin.tool?.skill)).toContain("skill")
                expect(plugin.tool?.autocode_job_execute).toBeDefined()
                expect(plugin.tool?.autocode_execute_job).toBeUndefined()
                expect(toolSurfaceText(plugin.tool?.autocode_agent_execute)).toContain("Swap current session to selected agent with job workspace instructions injected.")
                expect(toolSurfaceText(plugin.tool?.autocode_agent_execute)).toContain("Selected job_name in safe snake_case.")
                const sessionCreateToolText = toolSurfaceText(plugin.tool?.autocode_session_create)
                expect(sessionCreateToolText).toContain("Only call when requested by user.")
                expect(toolSurfaceText(plugin.tool?.autocode_job_execute)).not.toContain("job_name")
                expect(plugin.tool?.autocode_concept_create).toBeDefined()
                expect(plugin.tool?.autocode_plan_start).toBeUndefined()
                expect(plugin.tool?.autocode_db_table).toBeDefined()
                expect(plugin.tool?.autocode_db_table_read).toBeDefined()
                expect(plugin.tool?.autocode_db_tables).toBeDefined()
                expect(plugin.tool?.autocode_dependencies).toBeDefined()
                expect(plugin.tool?.autocode_rest).toBeDefined()
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
                expect(getPermissionRule(cfg.agent.design?.permission, "autocode_concept_list")).toBe("allow")
                expect(getPermissionRule(cfg.agent.design?.permission, "autocode_concept_read")).toBe("allow")
                expect(getPermissionRule(cfg.agent.design?.permission, "autocode_job_execute")).toBe("allow")
                expect(getPermissionRule(cfg.agent.design?.permission, "autocode_session_create")).toBe("allow")
                expect(getPermissionRule(cfg.agent.execute_author?.permission, "autocode_logo_find")).toBeUndefined()
                expect(getPermissionRule(cfg.agent.execute_author?.permission, "autocode_logo")).toBeUndefined()
                expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_dependencies")).toBeUndefined()
                expect(getPermissionRule(cfg.agent.execute_document?.permission, "autocode_dependencies")).toBeUndefined()
                expect(getPermissionRule(cfg.agent.auto_general?.permission, "*")).toBe("allow")
                expect(getPermissionRule(cfg.agent.auto_general?.permission, "doom_loop")).toBe("deny")
                expect(getTaskPermissionRule(cfg.agent.auto_general?.permission, "design")).toBe("deny")
                expect(cfg.agent.auto_general?.prompt).toContain("fallback auto orchestrator")
                expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_session_create")).toBe("allow")
                expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_feedback")).toBeUndefined()
                expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_review")).toBeUndefined()
                expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_job_list")).toBeUndefined()
                expect(getPermissionRule(cfg.agent.auto?.permission, "autocode_draft_job_create")).toBeUndefined()
                expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_session_create")).toBe("allow")
                expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_job_list")).toBeUndefined()
                expect(getPermissionRule(cfg.agent.assist?.permission, "autocode_auto_start")).toBeUndefined()
                expect(Object.keys(cfg.agent).filter((name) => name.startsWith("auto-") || name.startsWith("assist-"))).toEqual([])
                expect(cfg.agent.design?.prompt).toContain("PROPOSAL")
                expect(cfg.agent.design?.prompt).toContain("autocode_job_execute")
                expect(cfg.agent.advise?.prompt).toContain("# Teaching Guide")
                expect(cfg.agent.advise?.prompt).toContain("`task` query subagents")
                const queryDbAgent = (cfg.agent as Record<string, Record<string, unknown>>).query_db
                expect(queryDbAgent.mode).toBe("subagent")
                expect(queryDbAgent.hidden).toBe(true)
                expect(String(queryDbAgent.prompt)).toContain("Use only `autocode_db_tables`, `autocode_db_table`, and `autocode_db_table_read`")
                expect(String(queryDbAgent.prompt)).toContain("AUTOCODE_DB_<UPPERCASE_KEY>_CONNECTION")
                expect(queryDbAgent.permission).toEqual(expect.objectContaining({
                    "*": "deny",
                    autocode_db_table: "allow",
                    autocode_db_table_read: "allow",
                    autocode_db_tables: "allow",
                    external_directory: expect.objectContaining({ "*": "deny" }),
                }))
                const executeRestAgent = (cfg.agent as Record<string, Record<string, unknown>>).execute_rest
                expect(getAgentField(cfg, "execute_rest", "mode")).toBe("subagent")
                expect(getAgentField(cfg, "execute_rest", "hidden")).toBe(true)
                expect(executeRestAgent.tier).toBeUndefined()
                expect(getAgentField(cfg, "execute_rest", "temperature")).toBe(0.1)
                expect(String(executeRestAgent.prompt)).toContain("autocode_rest")
                expect(String(executeRestAgent.prompt)).toContain("GET, POST, PUT, PATCH, DELETE")
                expect(String(executeRestAgent.prompt)).toContain("Never dump full raw REST result unless user specifically asks")
                expect(String(executeRestAgent.prompt)).toContain("Do not leak sensitive headers or body unless user explicitly requested")
                expect(String(executeRestAgent.prompt)).toContain("ask user confirmation")
                expect(String(executeRestAgent.prompt)).toContain("Caveman English")
                expect(String(executeRestAgent.prompt)).not.toContain("`query`")
                expect(String(executeRestAgent.prompt)).not.toContain("rest_key")
                expect(executeRestAgent.permission).toEqual(expect.objectContaining({
                    "*": "deny",
                    autocode_rest: "allow",
                    external_directory: expect.objectContaining({ "*": "deny" }),
                }))
                expect(getPermissionRule(cfg.agent.execute_rest?.permission, "session")).toBeUndefined()
                expect(getPermissionRule(cfg.agent.execute_rest?.permission, "agent")).toBeUndefined()
                expect(getPermissionRule(cfg.agent.execute_rest?.permission, "previous_session")).toBeUndefined()
                expect(getPermissionRule(cfg.agent.execute_rest?.permission, "previous_agent")).toBeUndefined()
            } finally {
                if (previousSkipBootstrap === undefined) {
                    delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
                } else {
                    process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
                }
            }
        })
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
        writeFileSync(path: string, contents: string) {
            files[path] = contents
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
                            context: { model: "openai/gpt-5-context", variant: "high" },
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
        expect(result.tiers.context).toEqual({ model: "openai/gpt-5-context", variant: "high" })
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

    test("current direct tier schema is parsed", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tiers: {
                        cheap: { model: "openai/gpt-5-nano", variant: "economy" },
                        fast: { model: "anthropic/claude-haiku-4-5", variant: "quick" },
                        operator: { model: "openai/gpt-5", variant: "standard" },
                        context: { model: "openai/gpt-5-context", variant: "high" },
                        balanced: { model: "anthropic/claude-sonnet-4-5", variant: "standard" },
                        smart: { model: "anthropic/claude-opus-4-5", variant: "thinking" },
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.tiers.cheap).toEqual({ model: "openai/gpt-5-nano", variant: "economy" })
        expect(result.tiers.fast).toEqual({ model: "anthropic/claude-haiku-4-5", variant: "quick" })
        expect(result.tiers.operator).toEqual({ model: "openai/gpt-5", variant: "standard" })
        expect(result.tiers.context).toEqual({ model: "openai/gpt-5-context", variant: "high" })
        expect(result.tiers.balanced).toEqual({ model: "anthropic/claude-sonnet-4-5", variant: "standard" })
        expect(result.tiers.smart).toEqual({ model: "anthropic/claude-opus-4-5", variant: "thinking" })
    })

    test("context tier config accepts model and variant with local precedence", async () => {
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                autocode: { tiers: { context: { model: "openai/gpt-5", variant: "standard" } } },
            }),
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: { tiers: { context: { model: "anthropic/claude-opus-4-5", variant: "thinking" } } },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.tiers.context).toEqual({ model: "anthropic/claude-opus-4-5", variant: "thinking" })
    })

    test("provider-selected operator tier config is parsed", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tier: "openai",
                    tiers: {
                        openai: {
                            operator: { model: "openai/gpt-5", variant: "standard" },
                            balanced: { model: "openai/gpt-5-mini" },
                        },
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.tiers.operator).toEqual({ model: "openai/gpt-5", variant: "standard" })
        expect(result.tiers.balanced).toEqual({ model: "openai/gpt-5-mini" })
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

    test("direct tier-map supports every current tier", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: {
                    tiers: {
                        cheap: { model: "openai/gpt-5-nano", variant: "economy" },
                        fast: { model: "anthropic/claude-haiku-4-5" },
                        operator: { model: "openai/gpt-5", variant: "standard" },
                        context: { model: "openai/gpt-5-context", variant: "high" },
                        smart: { model: "anthropic/claude-opus-4-5", variant: "thinking" },
                        balanced: { model: "anthropic/claude-sonnet-4-5" },
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.tiers.cheap).toEqual({ model: "openai/gpt-5-nano", variant: "economy" })
        expect(result.tiers.fast).toEqual({ model: "anthropic/claude-haiku-4-5" })
        expect(result.tiers.operator).toEqual({ model: "openai/gpt-5", variant: "standard" })
        expect(result.tiers.context).toEqual({ model: "openai/gpt-5-context", variant: "high" })
        expect(result.tiers.smart).toEqual({ model: "anthropic/claude-opus-4-5", variant: "thinking" })
        expect(result.tiers.balanced).toEqual({ model: "anthropic/claude-sonnet-4-5" })
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
    let previousSkipBootstrap: string | undefined

    beforeAll(() => {
        previousSkipBootstrap = process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
        process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = "1"
    })

    afterAll(() => {
        if (previousSkipBootstrap === undefined) {
            delete process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP
        } else {
            process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP = previousSkipBootstrap
        }
    })

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
        await withIsolatedConfigHome(async () => {
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
    })

    test("cheap tier config populates runtime small_model and preserves existing tier mappings for current agent tiers", async () => {
        await withIsolatedConfigHome(async () => {
            const worktree = mkdtempSync(join(tmpdir(), "autocode-test-"))
            try {
                writeAutocodeTierConfig(worktree, {
                    tiers: {
                        cheap: { model: "openai/gpt-5-nano", variant: "economy" },
                        smart: { model: "anthropic/claude-opus-4-5", variant: "thinking" },
                        balanced: { model: "anthropic/claude-sonnet-4-5", variant: "standard" },
                        fast: { model: "anthropic/claude-haiku-4-5", variant: "quick" },
                        context: { model: "openai/gpt-5-context", variant: "high" },
                    },
                })

                const plugin = await autocode(createPluginInput(createTierClient(), worktree))
                const cfg: ConfigWithRuntimeSections & { small_model?: string } = { agent: {}, command: {} }

                await configurePlugin(plugin, cfg)

                expect(cfg.small_model).toBe("openai/gpt-5-nano")
                expect(getAgentField(cfg, "auto_general", "model")).toBe("anthropic/claude-sonnet-4-5")
                expect(getAgentField(cfg, "auto_general", "variant")).toBe("standard")
                expect(getAgentField(cfg, "compaction", "model")).toBe("openai/gpt-5-context")
                expect(getAgentField(cfg, "compaction", "variant")).toBe("high")
                expect(getAgentField(cfg, "design", "model")).toBe("anthropic/claude-sonnet-4-5")
                expect(getAgentField(cfg, "design", "variant")).toBe("standard")
                expect(getAgentField(cfg, "auto", "model")).toBe("anthropic/claude-opus-4-5")
                expect(getAgentField(cfg, "advise", "model")).toBe("anthropic/claude-sonnet-4-5")
                expect(getAgentField(cfg, "execute_code", "model")).toBe("anthropic/claude-sonnet-4-5")
                expect(getAgentField(cfg, "execute_code", "variant")).toBe("standard")
                expect(getAgentField(cfg, "query_git", "model")).toBe("anthropic/claude-haiku-4-5")
                expect(getAgentField(cfg, "query_git", "variant")).toBe("quick")
                expect(getAgentField(cfg, "query_code", "model")).toBe("openai/gpt-5-context")
                expect(getAgentField(cfg, "query_code", "variant")).toBe("high")
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
                expect(getAgentField(cfg, "advise", "tier")).toBeUndefined()
                expect(getAgentField(cfg, "auto", "tier")).toBeUndefined()
                expect(getAgentField(cfg, "execute_code", "tier")).toBeUndefined()
                expect(getAgentField(cfg, "query_git", "tier")).toBeUndefined()
                expect(getAgentField(cfg, "title", "model")).toBe("openai/gpt-5-nano")
                expect(getAgentField(cfg, "title", "variant")).toBe("economy")
                expect(getAgentField(cfg, "title", "tier")).toBeUndefined()
                expect(getAgentField(cfg, "title", "prompt")).toBeUndefined()
                expect(getAgentField(cfg, "title", "permission")).toBeUndefined()
                expect(getAgentField(cfg, "title", "mode")).toBeUndefined()
                expect(getAgentField(cfg, "title", "description")).toBeUndefined()
                expect(getAgentField(cfg, "title", "tools")).toBeUndefined()
                expect(getAgentField(cfg, "title", "instructions")).toBeUndefined()
                expect(getAgentField(cfg, "title", "behavior")).toBeUndefined()
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
                expect(getAgentField(cfg, "design", "model")).toBe("anthropic/claude-sonnet-4-5")
                expect(getAgentField(cfg, "auto", "model")).toBe("anthropic/claude-opus-4-5")
                expect(getAgentField(cfg, "advise", "model")).toBe("anthropic/claude-sonnet-4-5")
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
                        smart: { model: "anthropic/claude-sonnet-4-5" },
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
                        smart: { model: "anthropic/claude-sonnet-4-5" },
                        balanced: { model: "anthropic/claude-sonnet-4-5" },
                        fast: { model: "anthropic/claude-haiku-4-5" },
                    },
                })

                const titleAgent = { model: "user/title-model", prompt: "Keep title agent" }
                const plugin = await autocode(createPluginInput(createTierClient(), worktree))
                const cfg = { agent: { title: titleAgent }, command: {} } satisfies ConfigWithRuntimeSections

                await configurePlugin(plugin, cfg)

                expect(getAgentField(cfg, "title", "model")).toBe("user/title-model")
                expect(getAgentField(cfg, "title", "variant")).toBe("economy")
                expect(getAgentField(cfg, "title", "prompt")).toBe("Keep title agent")
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
                        smart: { model: "anthropic/claude-sonnet-4-5" },
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

    test("explicit compaction agent model overrides context tier model", async () => {
        await withIsolatedConfigHome(async () => {
            const worktree = mkdtempSync(join(tmpdir(), "autocode-test-"))
            try {
                writeAutocodeTierConfig(worktree, {
                    tiers: {
                        cheap: { model: "openai/gpt-5-nano", variant: "economy" },
                        smart: { model: "anthropic/claude-sonnet-4-5" },
                        balanced: { model: "anthropic/claude-sonnet-4-5" },
                        fast: { model: "anthropic/claude-haiku-4-5", variant: "quick" },
                        context: { model: "openai/gpt-5-context", variant: "high" },
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
                expect(getAgentField(cfg, "compaction", "variant")).toBe("high")
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
