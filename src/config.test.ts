import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { applyExternalDirectoryPolicy, buildAgents, toV2Permissions } from "./agents"
import { collectExternalDirectories, loadAutocodeConfig } from "./config"
import type { ConfigFileSystem } from "./config"
import { createPlatformCapabilities } from "./utils/platform"
import { resolveOpenCodePaths } from "./utils/paths"
import { permissionEffect, type PermissionRule } from "./utils/permissions"

function makeFs(files: Record<string, string>, createdPaths: string[] = [], readPaths: string[] = [], writtenPaths: string[] = []): ConfigFileSystem {
    return {
        readFileSync(path: string) {
            readPaths.push(path)
            if (path in files) return files[path]
            const err = new Error("ENOENT") as NodeJS.ErrnoException
            err.code = "ENOENT"
            throw err
        },
        ensureFileSync(path: string, contents: string) {
            if (!(path in files)) {
                files[path] = contents
                createdPaths.push(path)
            }
        },
        writeFileSync(path: string, contents: string) {
            files[path] = contents
            writtenPaths.push(path)
        },
    }
}

function globalAutocodeConfigPath(): string {
    return resolveOpenCodePaths().globalAutocodeConfigPath
}

function globalOpencodeConfigPath(extension: "json" | "jsonc"): string {
    return join(resolveOpenCodePaths().globalConfigRoot, `opencode.${extension}`)
}

function localAutocodeConfigPath(directory: string): string {
    return join(resolve(directory), ".opencode", "autocode.jsonc")
}

function localOpencodeConfigPath(directory: string, extension: "json" | "jsonc"): string {
    return join(resolve(directory), `opencode.${extension}`)
}

function getPermissionRule(permission: unknown, key: string): unknown {
    if (!permission) return undefined
    if (!Array.isArray(permission)) return (permission as Record<string, unknown>)[key]
    const rules = permission.filter((rule) => rule.action === key)
    if (!rules.length) return undefined
    if (rules.length === 1 && rules[0].resource === "*" && key !== "external_directory" && key !== "subagent") return rules[0].effect
    return Object.fromEntries(rules.map((rule) => [rule.resource, rule.effect]))
}

function getTaskPermissionRule(permission: unknown, key: string): unknown {
    const task = getPermissionRule(permission, Array.isArray(permission) ? "subagent" : "task")
    return typeof task === "object" && task !== null ? (task as Record<string, unknown>)[key] : undefined
}

describe("external directory config", () => {
    test("loadAutocodeConfig creates the missing global config file", async () => {
        const files: Record<string, string> = {}
        const createdPaths: string[] = []

        await loadAutocodeConfig("/wt", "/wt", makeFs(files, createdPaths))

        expect(createdPaths).toEqual([globalAutocodeConfigPath()])
        const content = files[globalAutocodeConfigPath()]
        expect(content).toContain('"skills"')
        expect(content).toContain('"freeze": false')
        expect(content).not.toContain('"bash"')
        expect(content).not.toContain('"code"')
        expect(content).not.toContain('"design"')
        expect(content).not.toContain('"test"')
    })

    test("loadAutocodeConfig does not create missing worktree or directory config files", async () => {
        const files: Record<string, string> = {}
        const createdPaths: string[] = []

        await loadAutocodeConfig(resolve("/wt"), resolve("/dir"), makeFs(files, createdPaths))

        expect(createdPaths).toEqual([globalAutocodeConfigPath()])
        expect(files[localAutocodeConfigPath("/wt")]).toBeUndefined()
        expect(files[localAutocodeConfigPath("/dir")]).toBeUndefined()
    })

    test("loadAutocodeConfig returns empty externalDirectories by default", async () => {
        const result = await loadAutocodeConfig("/wt", "/wt", makeFs({}))

        expect(result.externalDirectories).toEqual({})
    })

    test("loadAutocodeConfig keeps external_directory in candidate order and moves overrides last", async () => {
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                permissions: [
                    { action: "external_directory", resource: "/global/*", effect: "allow" },
                    { action: "external_directory", resource: "/shared/*", effect: "deny" },
                ],
            }),
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                permissions: [
                    { action: "external_directory", resource: "/worktree/*", effect: "ask" },
                    { action: "external_directory", resource: "/shared/*", effect: "allow" },
                ],
            }),
            [localAutocodeConfigPath("/dir")]: JSON.stringify({
                permissions: [{ action: "external_directory", resource: "/directory/*", effect: "deny" }],
            }),
        })

        const result = await loadAutocodeConfig(resolve("/wt"), resolve("/dir"), fs)

        expect(result.externalDirectories).toEqual({
            "/global/*": "allow",
            "/worktree/*": "ask",
            "/shared/*": "allow",
            "/directory/*": "deny",
        })
        expect(Object.keys(result.externalDirectories)).toEqual([
            "/global/*",
            "/worktree/*",
            "/shared/*",
            "/directory/*",
        ])
    })

    test("loadAutocodeConfig merges V2 external_directory rules from four sources in precedence order", async () => {
        const fs = makeFs({
            [globalOpencodeConfigPath("jsonc")]: JSON.stringify({
                permissions: [
                    { action: "external_directory", resource: "/global-opencode/*", effect: "allow" },
                    { action: "external_directory", resource: "/shared/*", effect: "deny" },
                ],
            }),
            [globalAutocodeConfigPath()]: JSON.stringify({
                permissions: [
                    { action: "external_directory", resource: "/global-autocode/*", effect: "ask" },
                    { action: "external_directory", resource: "/shared/*", effect: "allow" },
                ],
            }),
            [localOpencodeConfigPath("/wt", "json")]: JSON.stringify({
                permissions: [
                    { action: "external_directory", resource: "/local-opencode/*", effect: "deny" },
                    { action: "external_directory", resource: "/shared/*", effect: "ask" },
                ],
            }),
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                permissions: [
                    { action: "external_directory", resource: "/local-autocode/*", effect: "allow" },
                    { action: "external_directory", resource: "/shared/*", effect: "deny" },
                ],
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.externalDirectories).toEqual({
            "/global-opencode/*": "allow",
            "/global-autocode/*": "ask",
            "/local-opencode/*": "deny",
            "/local-autocode/*": "allow",
            "/shared/*": "deny",
        })
        expect(Object.keys(result.externalDirectories)).toEqual([
            "/global-opencode/*",
            "/global-autocode/*",
            "/local-opencode/*",
            "/local-autocode/*",
            "/shared/*",
        ])
    })

    test("loadAutocodeConfig prefers opencode.jsonc V2 rules over opencode.json", async () => {
        const fs = makeFs({
            [globalOpencodeConfigPath("jsonc")]: JSON.stringify({
                permissions: [{ action: "external_directory", resource: "/global-jsonc/*", effect: "allow" }],
            }),
            [globalOpencodeConfigPath("json")]: JSON.stringify({
                permissions: [{ action: "external_directory", resource: "/global-json/*", effect: "deny" }],
            }),
            [localOpencodeConfigPath("/wt", "jsonc")]: JSON.stringify({
                permissions: [{ action: "external_directory", resource: "/local-jsonc/*", effect: "ask" }],
            }),
            [localOpencodeConfigPath("/wt", "json")]: JSON.stringify({
                permissions: [{ action: "external_directory", resource: "/local-json/*", effect: "deny" }],
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.externalDirectories).toEqual({
            "/global-jsonc/*": "allow",
            "/local-jsonc/*": "ask",
        })
    })

    test("loadAutocodeConfig discovers sibling global configs under OPENCODE_CONFIG_DIR", async () => {
        const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
        const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
        const configRoot = resolve("/override/OpenCode Config")
        process.env.OPENCODE_CONFIG_DIR = configRoot
        process.env.XDG_CONFIG_HOME = "/ignored-xdg"

        try {
            const fs = makeFs({
                [join(configRoot, "opencode.json")]: JSON.stringify({ permissions: [{ action: "external_directory", resource: "/json/*", effect: "deny" }] }),
                [join(configRoot, "opencode.jsonc")]: JSON.stringify({ permissions: [{ action: "external_directory", resource: "/jsonc/*", effect: "allow" }] }),
                [join(configRoot, "autocode.jsonc")]: JSON.stringify({ permissions: [{ action: "external_directory", resource: "/autocode/*", effect: "ask" }] }),
            })

            const result = await loadAutocodeConfig("/wt", "/wt", fs)

            expect(result.externalDirectories).toEqual({ "/jsonc/*": "allow", "/autocode/*": "ask" })
        } finally {
            if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
            else process.env.OPENCODE_CONFIG_DIR = originalConfigDir

            if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
            else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
        }
    })

    test("loadAutocodeConfig ignores invalid external_directory actions", async () => {
        const fs = makeFs({
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                permissions: [
                    { action: "external_directory", resource: "/allowed/*", effect: "allow" },
                    { action: "external_directory", resource: "/invalid/*", effect: "maybe" },
                ],
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.externalDirectories).toEqual({
            "/allowed/*": "allow",
        })
    })

    test("loadAutocodeConfig ignores singular legacy external_directory object rules", async () => {
        const fs = makeFs({
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                permission: {
                    external_directory: {
                        "/native/*": "allow",
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.externalDirectories).toEqual({})
    })

    test("loadAutocodeConfig ignores singular legacy external_directory string rules", async () => {
        const fs = makeFs({
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                permission: {
                    external_directory: "ask",
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.externalDirectories).toEqual({})
    })

    test("loadAutocodeConfig loads ancestor configs upward with closer directory overrides", async () => {
        const fs = makeFs({
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                permissions: [
                    { action: "external_directory", resource: "/shared/*", effect: "deny" },
                    { action: "external_directory", resource: "/worktree/*", effect: "allow" },
                ],
            }),
            [localAutocodeConfigPath("/wt/packages")]: JSON.stringify({
                permissions: [
                    { action: "external_directory", resource: "/packages/*", effect: "ask" },
                    { action: "external_directory", resource: "/shared/*", effect: "allow" },
                ],
            }),
            [localAutocodeConfigPath("/wt/packages/app")]: JSON.stringify({
                permissions: [
                    { action: "external_directory", resource: "/app/*", effect: "allow" },
                    { action: "external_directory", resource: "/shared/*", effect: "ask" },
                ],
            }),
        })

        const result = await loadAutocodeConfig(resolve("/wt"), resolve("/wt/packages/app"), fs)

        expect(result.externalDirectories).toEqual({
            "/worktree/*": "allow",
            "/packages/*": "ask",
            "/app/*": "allow",
            "/shared/*": "ask",
        })
    })

    test("loadAutocodeConfig reads exact outside directory config without unrelated parents", async () => {
        const outsideParentConfigPath = localAutocodeConfigPath("/outside")
        const readPaths: string[] = []
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                permissions: [{ action: "external_directory", resource: "/global/*", effect: "allow" }],
            }),
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                permissions: [{ action: "external_directory", resource: "/worktree/*", effect: "ask" }],
            }),
            [outsideParentConfigPath]: JSON.stringify({
                permissions: [{ action: "external_directory", resource: "/outside-parent/*", effect: "deny" }],
            }),
            [localAutocodeConfigPath("/outside/project")]: JSON.stringify({
                permissions: [{ action: "external_directory", resource: "/outside-project/*", effect: "allow" }],
            }),
        }, [], readPaths)

        const result = await loadAutocodeConfig(resolve("/wt"), resolve("/outside/project"), fs)

        expect(result.externalDirectories).toEqual({
            "/global/*": "allow",
            "/worktree/*": "ask",
            "/outside-project/*": "allow",
        })
        expect(result.externalDirectories["/outside-parent/*"]).toBeUndefined()
        expect(readPaths).not.toContain(outsideParentConfigPath)
    })

    test("collectExternalDirectories reads only ordered V2 external_directory rules", () => {
        expect(collectExternalDirectories([
            { action: "external_directory", resource: "*", effect: "ask" },
            { action: "external_directory", resource: "/allowed/*", effect: "deny" },
            { action: "subagent", resource: "/allowed/*", effect: "allow" },
            { action: "external_directory", resource: "/allowed/*", effect: "allow" },
        ])).toEqual({ "*": "ask", "/allowed/*": "allow" })
        expect(collectExternalDirectories({ external_directory: "allow" })).toBeUndefined()
    })

    test("loadAutocodeConfig retains repeated V2 rules and final wildcard denial", async () => {
        const rules: PermissionRule[] = [
            { action: "external_directory", resource: "/shared/*", effect: "allow" },
            { action: "external_directory", resource: "/shared/*", effect: "ask" },
            { action: "external_directory", resource: "*", effect: "deny" },
        ]
        const result = await loadAutocodeConfig("/wt", "/wt", makeFs({
            [localAutocodeConfigPath("/wt")]: JSON.stringify({ permissions: rules }),
        }))

        expect(result.externalDirectoryPermissions).toEqual(rules)
    })

    test("existing local files still override global config", async () => {
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                permissions: [
                    { action: "external_directory", resource: "/shared/*", effect: "deny" },
                    { action: "external_directory", resource: "/global/*", effect: "allow" },
                ],
            }),
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                permissions: [{ action: "external_directory", resource: "/shared/*", effect: "allow" }],
            }),
            [localAutocodeConfigPath("/dir")]: JSON.stringify({
                permissions: [{ action: "external_directory", resource: "/shared/*", effect: "ask" }],
            }),
        })

        const result = await loadAutocodeConfig(resolve("/wt"), resolve("/dir"), fs)

        expect(result.externalDirectories).toEqual({
            "/global/*": "allow",
            "/shared/*": "ask",
        })
    })

    test("buildAgents applies centralized rules from original actions and question ask capability", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {
            "/allowed/*": "allow",
            "/review/*": "ask",
            "/blocked/*": "deny",
        })
        expect(getPermissionRule(agents.design?.permissions, "external_directory")).toEqual({
            "*": "ask",
            "/allowed/*": "allow",
            "/review/*": "ask",
            "/blocked/*": "deny",
        })
        expect(getPermissionRule(agents["execute-os"]?.permissions, "external_directory")).toEqual({
            "*": "allow",
            "/allowed/*": "allow",
            "/review/*": "deny",
            "/blocked/*": "deny",
        })
        expect(getPermissionRule(agents.assist?.permissions, "external_directory")).toEqual({
            "*": "ask",
            "/allowed/*": "allow",
            "/review/*": "ask",
            "/blocked/*": "deny",
        })
        expect(getPermissionRule(agents["query-code"]?.permissions, "external_directory")).toEqual({
            "*": "ask",
            "/allowed/*": "allow",
            "/review/*": "deny",
            "/blocked/*": "deny",
        })
    })

    test("applyExternalDirectoryPolicy normalizes allow ask and deny by question permission", () => {
        const agents = applyExternalDirectoryPolicy({
            question_allow: {
                permission: {
                    external_directory: "ask",
                    question: "allow",
                },
            },
            question_ask: {
                permission: {
                    external_directory: "ask",
                    question: "ask",
                },
            },
            question_deny: {
                permission: {
                    external_directory: "ask",
                    question: "deny",
                },
            },
            action_allow: {
                permission: {
                    external_directory: "allow",
                },
            },
            action_deny: {
                permission: {
                    external_directory: "deny",
                    question: "allow",
                },
            },
            object_rules: {
                permission: {
                    external_directory: {
                        "*": "ask",
                        "/source-allow/*": "allow",
                        "/source-deny/*": "deny",
                    },
                },
            },
        }, {
            "/configured-allow/*": "allow",
            "/configured-ask/*": "ask",
            "/configured-deny/*": "deny",
        })

        expect(getPermissionRule(agents.question_allow?.permission, "external_directory")).toEqual({
            "*": "ask",
            "/configured-allow/*": "allow",
            "/configured-ask/*": "ask",
            "/configured-deny/*": "deny",
        })
        expect(getPermissionRule(agents.question_ask?.permission, "external_directory")).toEqual({
            "*": "ask",
            "/configured-allow/*": "allow",
            "/configured-ask/*": "ask",
            "/configured-deny/*": "deny",
        })
        expect(getPermissionRule(agents.question_deny?.permission, "external_directory")).toEqual({
            "*": "deny",
            "/configured-allow/*": "allow",
            "/configured-ask/*": "deny",
            "/configured-deny/*": "deny",
        })
        expect(getPermissionRule(agents.action_allow?.permission, "external_directory")).toEqual({
            "*": "allow",
            "/configured-allow/*": "allow",
            "/configured-ask/*": "deny",
            "/configured-deny/*": "deny",
        })
        expect(getPermissionRule(agents.action_deny?.permission, "external_directory")).toEqual([
            { action: "external_directory", resource: "*", effect: "ask" },
            { action: "external_directory", resource: "/configured-allow/*", effect: "allow" },
            { action: "external_directory", resource: "/configured-ask/*", effect: "ask" },
            { action: "external_directory", resource: "/configured-deny/*", effect: "deny" },
            { action: "external_directory", resource: "*", effect: "deny" },
        ])
        const actionDenyRules = toV2Permissions(agents.action_deny?.permission)
        expect(permissionEffect(actionDenyRules, "external_directory", "/configured-allow/file.md")).toBe("deny")
        expect(getPermissionRule(agents.object_rules?.permission, "external_directory")).toEqual({
            "*": "deny",
            "/source-allow/*": "allow",
            "/source-deny/*": "deny",
            "/configured-allow/*": "allow",
            "/configured-ask/*": "deny",
            "/configured-deny/*": "deny",
        })
    })
})

describe("sandbox config", () => {
    test("loadAutocodeConfig parses hidden sandbox sync and distro cache config", async () => {
        for (const syncMethod of ["auto", "overlayfs", "reflink", "copy"] as const) {
            const fs = makeFs({
                [localAutocodeConfigPath("/wt")]: JSON.stringify({
                    autocode: {
                        sandbox: {
                            sync_method: syncMethod,
                            distro: {
                                cache_path: "/shared/autocode-distros",
                                expire: "1 month",
                            },
                        },
                    },
                }),
            })

            const result = await loadAutocodeConfig("/wt", "/wt", fs)

            expect(result.sandbox).toEqual({ sync_method: syncMethod, distro_cache_path: "/shared/autocode-distros", distro_expire: "1 month" })
        }
    })

    test("loadAutocodeConfig ignores invalid sandbox sync config and keeps absent default empty", async () => {
        const absent = await loadAutocodeConfig("/wt", "/wt", makeFs({}))
        const invalid = await loadAutocodeConfig("/wt", "/wt", makeFs({
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                autocode: {
                    sandbox: {
                        sync_method: "rsync",
                        distro: {
                            cache_path: 123,
                            expire: false,
                        },
                    },
                },
            }),
        }))

        expect(absent.sandbox).toEqual({})
        expect(invalid.sandbox).toEqual({})
    })

    test("closer sandbox config overrides global values without exposing tool schema settings", async () => {
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                autocode: { sandbox: { sync_method: "copy", distro: { cache_path: "/global/cache", expire: "never" } } },
            }),
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                autocode: { sandbox: { sync_method: "reflink", distro: { cache_path: "/worktree/cache" } } },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.sandbox).toEqual({ sync_method: "reflink", distro_cache_path: "/worktree/cache", distro_expire: "never" })
    })
})

describe("agent workflow wiring", () => {
    const legacyAgentIds = [
        "assist_browser", "auto_author", "auto_design", "auto_feature", "auto_general", "auto_refactor", "auto_research", "auto_test", "auto_troubleshoot",
        "document_agents", "document_conventions", "document_code", "document_env", "document_install", "document_prd", "document_ux",
        "execute_author", "execute_code", "execute_config", "execute_debug", "execute_document", "execute_excel", "execute_opencode", "execute_os", "execute_rest", "execute_sandbox", "execute_script", "execute_ssh",
        "query_autocode", "query_browser", "query_code", "query_config", "query_db", "query_excel", "query_git", "query_os", "query_skills", "query_ssh", "query_text", "query_web", "query_youtube",
    ] as const

    test("keeps canonical auto and assist agents without removed workflow variants", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, undefined, [], { balanced: {}, smart: {} })

        expect(agents.auto).toBeDefined()
        expect(agents.assist).toBeDefined()
        for (const agentId of legacyAgentIds) expect(agents[agentId]).toBeUndefined()
    })

    test("keeps current canonical permissions on primary workflow agents", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, undefined, [], { balanced: {}, smart: {} })

        expect(getTaskPermissionRule(agents.assist?.permissions, "auto*")).toBe("deny")
        expect(getTaskPermissionRule(agents.auto?.permissions, "auto-*")).toBe("allow")
        expect(getPermissionRule(agents.assist?.permissions, "question")).toBe("allow")
        expect(getPermissionRule(agents.auto?.permissions, "question")).toBeUndefined()
    })

    test("does not register legacy act or ask primary agents", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"))

        expect(agents.act).toBeUndefined()
        expect(agents.ask).toBeUndefined()
    })
})

describe("learned config", () => {
    test("freshly created global config file contains skills.learned default max=10", async () => {
        const files: Record<string, string> = {}
        const createdPaths: string[] = []

        await loadAutocodeConfig("/wt", "/wt", makeFs(files, createdPaths))

        expect(createdPaths).toEqual([globalAutocodeConfigPath()])
        const content = files[globalAutocodeConfigPath()]
        expect(content).toContain('"learned"')
        expect(content).toContain('"max": 10')
    })

    test("loadAutocodeConfig returns skills.learned.max from local config", async () => {
        const fs = makeFs({
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                autocode: {
                    skills: { learned: { max: 3 } },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills?.learned).toEqual({ max: 3 })
    })

    test("loadAutocodeConfig falls back to default max=10 when max is invalid", async () => {
        for (const invalid of ["oops", 0, -2, 2.5, null]) {
            const fs = makeFs({
                [localAutocodeConfigPath("/wt")]: JSON.stringify({
                    autocode: {
                        skills: { learned: { max: invalid } },
                    },
                }),
            })

            const result = await loadAutocodeConfig("/wt", "/wt", fs)

            expect(result.skills?.learned).toEqual({ max: 10 })
        }
    })

    test("loadAutocodeConfig defaults skills.learned when absent from local config", async () => {
        const fs = makeFs({
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                autocode: {
                    sandbox: { sync_method: "copy" },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.skills?.learned).toEqual({ max: 10 })
    })
})

describe("model tier config", () => {
    test("loadAutocodeConfig accepts directly configured spy tier", async () => {
        const result = await loadAutocodeConfig("/wt", "/wt", makeFs({
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                autocode: { tiers: { spy: { model: "openai/gpt-spy", variant: "strict" } } },
            }),
        }))

        expect(result.tiers.spy).toEqual({ model: "openai/gpt-spy", variant: "strict" })
    })

    test("loadAutocodeConfig selects spy tier from configured provider", async () => {
        const result = await loadAutocodeConfig("/wt", "/wt", makeFs({
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                autocode: {
                    tier: "openai",
                    tiers: { openai: { spy: { model: "openai/gpt-spy" } } },
                },
            }),
        }))

        expect(result.tiers.spy).toEqual({ model: "openai/gpt-spy" })
    })

    test("loadAutocodeConfig accepts legacy spy model and variant aliases", async () => {
        const result = await loadAutocodeConfig("/wt", "/wt", makeFs({
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                autocode: {
                    model: { spy: "openai/gpt-spy" },
                    variant: { spy: "strict" },
                },
            }),
        }))

        expect(result.tiers.spy).toEqual({ model: "openai/gpt-spy", variant: "strict" })
    })

    test("loadAutocodeConfig reapplies selected provider tiers after direct merges", async () => {
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                autocode: {
                    tier: "anthropic",
                    tiers: {
                        anthropic: {
                            context: { model: "anthropic/claude-opus-4-5", variant: "standard" },
                            operator: { model: "anthropic/claude-sonnet-4-5", variant: "standard" },
                        },
                    },
                },
            }),
            [localAutocodeConfigPath("/wt")]: JSON.stringify({
                autocode: {
                    tiers: {
                        context: { model: "openai/gpt-5-context", variant: "high" },
                        anthropic: {
                            context: { variant: "thinking" },
                        },
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)
        
        expect(result.tiers).toEqual({
            context: { model: "anthropic/claude-opus-4-5", variant: "thinking" },
            operator: { model: "anthropic/claude-sonnet-4-5", variant: "standard" },
        })
    })
})
