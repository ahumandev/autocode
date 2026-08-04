import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Config as PluginHookConfig, PluginInput } from "@opencode-ai/plugin"
import type { Config as PluginConfig } from "@opencode-ai/sdk/v2"
import autocode from "./plugin"
import { createCommands } from "./commands"
import type { SandboxPlatformSupportOptions } from "@/utils/sandbox"
import { createPlatformCapabilities } from "./utils/platform"

const tempRoots: string[] = []

type PluginConfigHook = { config?: (input: PluginConfig) => Promise<void> }
type PluginInputWithSandboxSupportOverride = PluginInput & {
    sandboxSupportOverride?: SandboxPlatformSupportOptions
    platformOverride?: NodeJS.Platform
    homeOverride?: string
}
type PluginAgentConfig = NonNullable<NonNullable<PluginHookConfig["agent"]>[string]>
type SandboxPermission = NonNullable<PluginAgentConfig["permission"]> & {
    autocode_sandbox_cli?: "ask" | "allow" | "deny"
    task?: { execute_sandbox?: "ask" | "allow" | "deny" }
}
type PluginConfigWithSandboxPermissions = Omit<PluginHookConfig, "agent"> & {
    agent?: Record<string, Omit<PluginAgentConfig, "permission"> & { permission?: SandboxPermission } | undefined>
}
type SkillSource = { type: "directory", path: string }
type V2Plugin = {
    setup(context: PluginInputWithSandboxSupportOverride & {
        skill: { transform(callback: (draft: { source(source: SkillSource): void }) => void): void }
    }): Promise<void>
}

async function createTempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "autocode-plugin-test-"))
    tempRoots.push(root)
    return root
}

async function withEnv(entries: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
    const originals = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(entries)) {
        originals.set(key, process.env[key])
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }

    try {
        await run()
    }
    finally {
        for (const [key, value] of originals) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

function createInput(
    worktree: string,
    sandboxSupportOverride: SandboxPlatformSupportOptions = { platform: "linux", env: {}, bwrapUsable: true },
): PluginInputWithSandboxSupportOverride {
    return {
        worktree,
        directory: worktree,
        client: {},
        sandboxSupportOverride,
    } as PluginInputWithSandboxSupportOverride
}

async function registerGeneratedSkills(input: PluginInputWithSandboxSupportOverride): Promise<SkillSource[]> {
    const sources: SkillSource[] = []
    await (autocode as unknown as V2Plugin).setup({
        ...input,
        skill: {
            transform(callback) {
                callback({
                    source(source) {
                        sources.push(source)
                    },
                })
            },
        },
    })
    return sources
}

function skillPermissions(config: PluginConfig, agentName: string): Record<string, unknown> | undefined {
    const permission = config.agent?.[agentName]?.permission
    if (!permission || typeof permission === "string") return undefined
    const skill = (permission as Record<string, unknown>).skill
    return skill && typeof skill !== "string" ? skill as Record<string, unknown> : undefined
}

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("autocode plugin config", () => {
    test("merges plugin config while preserving user command and agent overrides", async () => {
        const root = await createTempRoot()
        const worktree = join(root, "worktree")
        const configHome = join(root, "xdg")
        await mkdir(join(worktree, ".opencode"), { recursive: true })
        await writeFile(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({
            autocode: {
                tiers: {
                    cheap: { model: "cheap-model", variant: "high" },
                    fast: { model: "fast-model" },
                    balanced: { model: "balanced-model", variant: "balanced-variant" },
                    smart: { model: "smart-model" },
                },
            },
            permission: {
                external_directory: {
                    "/configured/*": "allow",
                },
            },
        }))

        await withEnv({ XDG_CONFIG_HOME: configHome, HOME: root, AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP: "1" }, async () => {
            const cfg: PluginConfig = {
                agent: {
                    assist: {
                        model: "user-model",
                        permission: {
                            question: "allow",
                            task_external: "ask",
                        },
                    },
                },
                command: {
                    "job-execute": {
                        description: "user description",
                        template: "user template",
                        subtask: true,
                    },
                },
                permission: {
                    external_directory: {
                        "/native/*": "ask",
                        "/configured/*": "deny",
                    },
                },
            }
            const input = { ...createInput(worktree), homeOverride: root }
            const hooks = await autocode(input) as unknown as PluginConfigHook
            const commands = createCommands(createPlatformCapabilities("linux"))

            await hooks.config?.(cfg)

            expect(cfg.small_model).toBe("cheap-model")
            expect(cfg.agent?.title).toEqual(expect.objectContaining({
                model: "cheap-model",
                variant: "high",
            }))
            expect(cfg.agent?.title?.options?.reasoningEffort).toBeUndefined()
            expect(cfg.agent?.compaction?.model).toBeUndefined()
            expect(cfg.command?.["job-execute"]).toEqual(expect.objectContaining({
                description: "user description",
                template: "user template",
                subtask: true,
            }))
            expect(cfg.command?.["job-execute"]?.agent).toBe("design")
            expect(cfg.command?.["job-facilitate"]?.template).toContain("autocode_job_execute")
            expect(Object.keys(cfg.command ?? {})).toEqual(["job-execute", "job-concepts", "job-design", "job-draft", "job-facilitate", "job-shelve", "assist", "auto", "design", "research", "teach", "autocode-install", "autocode-version", "author", "commit", "docs", "docs-conventions", "docs-code", "docs-env", "docs-prd", "docs-ux", "explain", "fix", "git-conflict", "init", "install", "learn", "repeat-as-md", "repeat-as-wiki", "report", "resume", "tests"])
            for (const [name, commandDef] of Object.entries(commands)) {
                if (name === "job-execute") continue
                expect(cfg.command?.[name]).toEqual(commandDef)
            }
            expect(cfg.command?.["job-execute"]).toEqual({
                ...commands["job-execute"],
                description: "user description",
                template: "user template",
                subtask: true,
            })
            expect(cfg.agent?.assist?.model).toBe("user-model")
            expect(cfg.agent?.assist?.variant).toBe("balanced-variant")
            const assist = cfg.agent?.assist
            const design = cfg.agent?.design
            const assistPermission = assist?.permission
            expect(((assist ?? {}) as Record<string, unknown>).tier).toBeUndefined()
            expect(cfg.agent?.design?.model).toBe("balanced-model")
            expect(((design ?? {}) as Record<string, unknown>).tier).toBeUndefined()
            expect(((assistPermission ?? {}) as Record<string, unknown>).external_directory).toEqual({
                "*": "ask",
                "/native/*": "ask",
                "/configured/*": "allow",
            })
            expect(await registerGeneratedSkills(input)).toContainEqual({
                type: "directory",
                path: join(root, ".agents", "skills", "autocode"),
            })

            const explicitTitleConfig: PluginConfig = {
                agent: {
                    title: {
                        options: {
                            reasoningEffort: "high",
                        },
                    },
                },
            }
            await hooks.config?.(explicitTitleConfig)

            expect(explicitTitleConfig.agent?.title?.options?.reasoningEffort).toBe("high")
        })
    })

    test("Windows removes sandbox exposure from user agent overrides", async () => {
        const root = await createTempRoot()
        const worktree = join(root, "worktree")
        const cfg: PluginConfigWithSandboxPermissions = {
            agent: {
                execute_sandbox: {
                    prompt: "sandbox guidance",
                    permission: { autocode_sandbox_cli: "allow" },
                },
                assist: {
                    prompt: "use sandbox guidance",
                    permission: {
                        autocode_sandbox_cli: "allow",
                        task: { execute_sandbox: "allow" },
                    },
                },
            },
        }
        const input: PluginInputWithSandboxSupportOverride = {
            ...createInput(worktree),
            platformOverride: "win32",
        }
        const hooks = await autocode(input)

        await hooks.config?.(cfg as PluginHookConfig)

        expect(cfg.agent?.execute_sandbox).toBeUndefined()
        for (const toolName of ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy", "autocode_sandbox_config_edit", "autocode_sandbox_config_read", "autocode_sandbox_config_remove"]) {
            expect(hooks.tool).not.toHaveProperty(toolName)
        }
        for (const agent of Object.values(cfg.agent ?? {})) {
            expect(agent).toBeDefined()
            if (agent === undefined) throw new Error("agent override unexpectedly undefined")
            const permission = agent.permission
            const rules = permission && typeof permission !== "string" ? permission as Record<string, unknown> : undefined
            for (const toolName of ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy", "autocode_sandbox_config_edit", "autocode_sandbox_config_read", "autocode_sandbox_config_remove"]) {
                expect(rules?.[toolName]).toBeUndefined()
            }
            const task = rules?.task
            const taskRules = task && typeof task === "object" ? task as Record<string, unknown> : undefined
            expect(taskRules?.execute_sandbox).toBeUndefined()
            expect(`${agent.description ?? ""}\n${agent.prompt ?? ""}`).not.toMatch(/sandbox/i)
        }
        for (const agentName of ["execute_os", "query_os"] as const) {
            expect(cfg.agent?.[agentName]?.prompt).toMatch(/cmd commands/i)
            expect(cfg.agent?.[agentName]?.prompt).toMatch(/never use bash/i)
        }
        expect(cfg.command?.install?.template).toContain("Run commands in CMD")
    })

    test("Linux preserves supported sandbox registrations and Bash guidance", async () => {
        const root = await createTempRoot()
        const worktree = join(root, "worktree")
        const hooks = await autocode(createInput(worktree))
        const cfg: PluginConfig = {}

        await hooks.config?.(cfg as unknown as PluginHookConfig)

        expect(cfg.agent?.execute_sandbox).toBeDefined()
        for (const toolName of ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy", "autocode_sandbox_config_edit", "autocode_sandbox_config_read", "autocode_sandbox_config_remove"]) {
            expect(hooks.tool).toHaveProperty(toolName)
        }
        expect(cfg.agent?.execute_os?.prompt).toMatch(/always use the `bash` tool/i)
        expect(cfg.agent?.query_os?.prompt).toMatch(/prefer other tools over `bash` tool/i)
        expect(cfg.command?.install?.template).toContain("If bwrap install is needed")
    })

    test("PowerShell startup assigns PowerShell-only OS prompts", async () => {
        const root = await createTempRoot()
        const worktree = join(root, "worktree")

        await withEnv({ PSModulePath: "present" }, async () => {
            const input: PluginInputWithSandboxSupportOverride = {
                ...createInput(worktree),
                platformOverride: "win32",
            }
            const hooks = await autocode(input)
            const cfg: PluginConfig = {}
            await hooks.config?.(cfg as unknown as PluginHookConfig)

            for (const agentName of ["execute_os", "query_os"] as const) {
                expect(cfg.agent?.[agentName]?.prompt).toMatch(/windows powershell/i)
                expect(cfg.agent?.[agentName]?.prompt).not.toMatch(/cmd commands/i)
            }
            expect(cfg.command?.install?.template).toContain("Run commands in CMD")
        })
    })

    test("Linux startup config prepends Bun bin using POSIX paths", async (): Promise<void> => {
        const root = await createTempRoot()
        const home = `${root}/Jane Doe`
        const originalPath = "/usr/local/bin:/usr/bin:/custom/bin"

        await withEnv({ HOME: home, PATH: originalPath, BUN_INSTALL: undefined }, async (): Promise<void> => {
            const input: PluginInputWithSandboxSupportOverride = {
                ...createInput(join(root, "worktree")),
                homeOverride: home,
            }
            const hooks = await autocode(input) as unknown as PluginConfigHook
            await hooks.config?.({})

            expect(process.env.BUN_INSTALL).toBe(`${home}/.bun`)
            expect(process.env.PATH).toBe(`${home}/.bun/bin:${originalPath}`)
        })
    })

    test("Windows startup config prepends Bun bin using Windows paths", async (): Promise<void> => {
        const root = await createTempRoot()
        const home = "C:\\Users\\Jane Doe"
        const originalPath = "C:\\Windows\\System32;C:\\Tools\\bin"
        const worktree = join(root, "worktree")
        await mkdir(join(worktree, ".opencode"), { recursive: true })
        await writeFile(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({ autocode: { skills: { freeze: true } } }))

        await withEnv({ HOME: undefined, PATH: originalPath, BUN_INSTALL: undefined }, async (): Promise<void> => {
            const input: PluginInputWithSandboxSupportOverride = {
                ...createInput(worktree),
                platformOverride: "win32",
                homeOverride: home,
            }
            const hooks = await autocode(input) as unknown as PluginConfigHook
            await hooks.config?.({})

            expect(process.env.BUN_INSTALL).toBe("C:\\Users\\Jane Doe\\.bun")
            expect(process.env.PATH).toBe(`C:\\Users\\Jane Doe\\.bun\\bin;${originalPath}`)
        })
    })

    test("startup reconciliation makes no network calls", async () => {
        const root = await createTempRoot()
        const originalFetch = globalThis.fetch
        let fetchCalls = 0
        globalThis.fetch = Object.assign(
            async (..._args: Parameters<typeof fetch>): Promise<Response> => {
                fetchCalls += 1
                throw new Error("network must not run during startup")
            },
            { preconnect: originalFetch.preconnect.bind(originalFetch) },
        )

        try {
            await withEnv({ XDG_CONFIG_HOME: join(root, "xdg"), HOME: root }, async () => {
                const input: PluginInputWithSandboxSupportOverride = {
                    ...createInput(join(root, "worktree")),
                    homeOverride: root,
                }
                const hooks = await autocode(input) as unknown as PluginConfigHook
                await hooks.config?.({})
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        expect(fetchCalls).toBe(0)
    })

    test("frozen skills skip startup writes and network while exposing existing generated root", async () => {
        const root = await createTempRoot()
        const configHome = join(root, "xdg")
        const worktree = join(root, "worktree")
        const generatedRoot = join(root, ".agents", "skills", "autocode")
        const existingSkill = join(generatedRoot, "existing", "SKILL.md")
        await mkdir(join(configHome, "opencode"), { recursive: true })
        await mkdir(join(worktree, ".opencode"), { recursive: true })
        await mkdir(join(generatedRoot, "existing"), { recursive: true })
        await writeFile(join(configHome, "opencode", "autocode.jsonc"), JSON.stringify({ autocode: { skills: { freeze: false } } }))
        await writeFile(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({ autocode: { skills: { freeze: true } } }))
        await writeFile(existingSkill, "pre-existing skill")
        const originalFetch = globalThis.fetch
        let fetchCalls = 0
        globalThis.fetch = Object.assign(
            async (..._args: Parameters<typeof fetch>): Promise<Response> => {
                fetchCalls += 1
                throw new Error("network must not run during frozen startup")
            },
            { preconnect: originalFetch.preconnect.bind(originalFetch) },
        )

        try {
            await withEnv({ XDG_CONFIG_HOME: configHome, HOME: root }, async () => {
                const input = { ...createInput(worktree), homeOverride: root }
                const hooks = await autocode(input) as unknown as PluginConfigHook
                const cfg: PluginConfig = {}
                await hooks.config?.(cfg)

                expect(await registerGeneratedSkills(input)).toContainEqual({ type: "directory", path: generatedRoot })
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        expect(await readdir(generatedRoot)).toEqual(["existing"])
        expect(await Bun.file(existingSkill).text()).toBe("pre-existing skill")
        expect(fetchCalls).toBe(0)
    })

    test("legacy skill URL has no startup fetch, grant, or generated-file effect", async () => {
        const root = await createTempRoot()
        const configHome = join(root, "xdg")
        const worktree = join(root, "worktree")
        const legacyUrl = "https://github.com/example/legacy-startup-url/blob/main/SKILL.md"
        await mkdir(join(configHome, "opencode"), { recursive: true })
        await mkdir(join(worktree, ".opencode"), { recursive: true })
        await writeFile(join(configHome, "opencode", "autocode.jsonc"), JSON.stringify({ autocode: { skills: { freeze: false } } }))
        await writeFile(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({
            autocode: { skills: { freeze: true, bash: [legacyUrl] } },
        }))
        const originalFetch = globalThis.fetch
        let fetchCalls = 0
        globalThis.fetch = Object.assign(
            async (..._args: Parameters<typeof fetch>): Promise<Response> => {
                fetchCalls += 1
                throw new Error("legacy URL must not fetch during startup")
            },
            { preconnect: originalFetch.preconnect.bind(originalFetch) },
        )

        try {
            await withEnv({ XDG_CONFIG_HOME: configHome, HOME: root }, async () => {
                const input = { ...createInput(worktree), homeOverride: root }
                const hooks = await autocode(input) as unknown as PluginConfigHook
                const cfg: PluginConfig = {}
                await hooks.config?.(cfg)

                expect(skillPermissions(cfg, "execute_os")?.["legacy-startup-url"]).toBeUndefined()
                expect(await registerGeneratedSkills(input)).toContainEqual({
                    type: "directory",
                    path: join(root, ".agents", "skills", "autocode"),
                })
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        expect(fetchCalls).toBe(0)
        expect(await readdir(join(root, ".agents", "skills")).catch(() => [])).toEqual([])
    })

    test("manifest skills grant matching category agents without duplicate grants", async () => {
        const root = await createTempRoot()
        const configHome = join(root, "xdg")
        const worktree = join(root, "worktree")
        await mkdir(join(configHome, "opencode"), { recursive: true })
        await mkdir(join(worktree, ".opencode"), { recursive: true })
        await writeFile(join(configHome, "opencode", "autocode.jsonc"), JSON.stringify({ autocode: { skills: { freeze: false } } }))
        await writeFile(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({ autocode: { skills: { freeze: true } } }))

        await withEnv({ XDG_CONFIG_HOME: configHome, HOME: root }, async () => {
            const input: PluginInputWithSandboxSupportOverride = {
                ...createInput(worktree),
                homeOverride: root,
            }
            const hooks = await autocode(input) as unknown as PluginConfigHook
            const cfg: PluginConfig = {}
            await hooks.config?.(cfg)

            expect(skillPermissions(cfg, "execute_code")?.["angular-developer"]).toBe("allow")
            expect(skillPermissions(cfg, "execute_os")?.["angular-developer"]).toBeUndefined()
            expect(skillPermissions(cfg, "auto_test")?.["vitest"]).toBe("allow")
            expect(skillPermissions(cfg, "assist")?.["codebase-design"]).toBe("allow")
            expect(skillPermissions(cfg, "auto")?.["codebase-design"]).toBe("allow")
            expect(skillPermissions(cfg, "design")?.["codebase-design"]).toBe("allow")
            const grants = Object.keys(skillPermissions(cfg, "execute_code") ?? {})
            expect(new Set(grants).size).toBe(grants.length)
        })
    })
})
