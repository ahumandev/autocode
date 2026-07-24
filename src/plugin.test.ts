import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir, readdir } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Config as PluginConfig } from "@opencode-ai/sdk/v2"
import autocode from "./plugin"
import type { SandboxPlatformSupportOptions } from "@/utils/sandbox"

const tempRoots: string[] = []

type PluginConfigHook = { config?: (input: PluginConfig) => Promise<void> }
type PluginInputWithSandboxSupportOverride = PluginInput & {
    sandboxSupportOverride?: SandboxPlatformSupportOptions
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
                    "job-execute-auto": {
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
                skills: {
                    paths: ["/user/skills"],
                },
            }
            const hooks = await autocode(createInput(worktree)) as unknown as PluginConfigHook

            await hooks.config?.(cfg)

            expect(cfg.small_model).toBe("cheap-model")
            expect(cfg.agent?.title).toEqual(expect.objectContaining({
                model: "cheap-model",
                variant: "high",
            }))
            expect(cfg.agent?.title?.options?.reasoningEffort).toBeUndefined()
            expect(cfg.agent?.compaction?.model).toBe("fast-model")
            expect(cfg.command?.["job-execute-auto"]).toEqual(expect.objectContaining({
                description: "user description",
                template: "user template",
                subtask: true,
            }))
            expect(cfg.command?.["job-execute-auto"]?.agent).toBe("design")
            expect(cfg.command?.["job-execute-assist"]?.template).toContain("autocode_job_execute")
            expect(cfg.agent?.assist?.model).toBe("user-model")
            expect(cfg.agent?.assist?.variant).toBe("balanced-variant")
            expect((cfg.agent?.assist as Record<string, unknown>).tier).toBeUndefined()
            expect(cfg.agent?.design?.model).toBe("smart-model")
            expect((cfg.agent?.design as Record<string, unknown>).tier).toBeUndefined()
            expect((cfg.agent?.assist?.permission as Record<string, unknown>).external_directory).toEqual({
                "*": "ask",
                "/native/*": "ask",
                "/configured/*": "allow",
            })
            expect(cfg.skills?.paths?.[0]).toBe(join(configHome, "skills", "autocode"))
            expect(cfg.skills?.paths?.[1]).toBe("/user/skills")

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
                const hooks = await autocode(createInput(join(root, "worktree"))) as unknown as PluginConfigHook
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
        const generatedRoot = join(configHome, "skills", "autocode")
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
                const hooks = await autocode(createInput(worktree)) as unknown as PluginConfigHook
                const cfg: PluginConfig = {}
                await hooks.config?.(cfg)

                expect(cfg.skills?.paths?.[0]).toBe(generatedRoot)
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
                const hooks = await autocode(createInput(worktree)) as unknown as PluginConfigHook
                const cfg: PluginConfig = {}
                await hooks.config?.(cfg)

                expect(skillPermissions(cfg, "execute_os")?.["legacy-startup-url"]).toBeUndefined()
                expect(cfg.skills?.paths?.[0]).toBe(join(configHome, "skills", "autocode"))
            })
        } finally {
            globalThis.fetch = originalFetch
        }

        expect(fetchCalls).toBe(0)
        expect(await readdir(join(configHome, "skills")).catch(() => [])).toEqual([])
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
            const hooks = await autocode(createInput(worktree)) as unknown as PluginConfigHook
            const cfg: PluginConfig = {}
            await hooks.config?.(cfg)

            expect(skillPermissions(cfg, "execute_code")?.["angular-developer"]).toBe("allow")
            expect(skillPermissions(cfg, "execute_os")?.["angular-developer"]).toBeUndefined()
            expect(skillPermissions(cfg, "execute_os")?.["drawio"]).toBe("allow")
            expect(skillPermissions(cfg, "execute_script")?.["drawio"]).toBe("allow")
            expect(skillPermissions(cfg, "auto_test")?.["vitest"]).toBe("allow")
            expect(skillPermissions(cfg, "assist")?.["codebase-design"]).toBe("allow")
            expect(skillPermissions(cfg, "auto")?.["codebase-design"]).toBe("allow")
            expect(skillPermissions(cfg, "design")?.["codebase-design"]).toBe("allow")
            const grants = Object.keys(skillPermissions(cfg, "execute_code") ?? {})
            expect(new Set(grants).size).toBe(grants.length)
        })
    })
})
