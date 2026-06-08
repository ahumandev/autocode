import { describe, expect, test } from "bun:test"
import { homedir } from "os"
import { join } from "path"
import { applyExternalDirectoryPolicy, buildAgents } from "./agents"
import { collectExternalDirectories, loadAutocodeConfig } from "./config"
import type { ConfigFileSystem } from "./config"
import type { PermissionConfig } from "@opencode-ai/sdk/v2"

function makeFs(files: Record<string, string>, createdPaths: string[] = [], readPaths: string[] = []): ConfigFileSystem {
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
    }
}

function globalAutocodeConfigPath(): string {
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "autocode.jsonc")
}

function getPermissionRule(permission: PermissionConfig | undefined, key: string): unknown {
    if (!permission || typeof permission === "string") {
        return undefined
    }

    return (permission as Record<string, unknown>)[key]
}

function getTaskPermissionRule(permission: PermissionConfig | undefined, key: string): unknown {
    if (!permission || typeof permission === "string") {
        return undefined
    }

    const task = (permission as Record<string, unknown>).task
    if (!task || typeof task === "string") {
        return undefined
    }

    return (task as Record<string, unknown>)[key]
}

describe("external directory config", () => {
    test("loadAutocodeConfig creates the missing global config file", async () => {
        const files: Record<string, string> = {}
        const createdPaths: string[] = []

        await loadAutocodeConfig("/wt", "/wt", makeFs(files, createdPaths))

        expect(createdPaths).toEqual([globalAutocodeConfigPath()])
        expect(files[globalAutocodeConfigPath()]).toBe("{}\n")
    })

    test("loadAutocodeConfig does not create missing worktree or directory config files", async () => {
        const files: Record<string, string> = {}
        const createdPaths: string[] = []

        await loadAutocodeConfig("/wt", "/dir", makeFs(files, createdPaths))

        expect(createdPaths).toEqual([globalAutocodeConfigPath()])
        expect(files["/wt/.opencode/autocode.jsonc"]).toBeUndefined()
        expect(files["/dir/.opencode/autocode.jsonc"]).toBeUndefined()
    })

    test("loadAutocodeConfig returns empty externalDirectories by default", async () => {
        const result = await loadAutocodeConfig("/wt", "/wt", makeFs({}))

        expect(result.externalDirectories).toEqual({})
    })

    test("loadAutocodeConfig keeps external_directory in candidate order and moves overrides last", async () => {
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                permission: {
                    external_directory: {
                        "/global/*": "allow",
                        "/shared/*": "deny",
                    },
                },
            }),
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                permission: {
                    external_directory: {
                        "/worktree/*": "ask",
                        "/shared/*": "allow",
                    },
                },
            }),
            "/dir/.opencode/autocode.jsonc": JSON.stringify({
                permission: {
                    external_directory: {
                        "/directory/*": "deny",
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/dir", fs)

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

    test("loadAutocodeConfig ignores invalid external_directory actions", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                permission: {
                    external_directory: {
                        "/allowed/*": "allow",
                        "/invalid/*": "maybe",
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.externalDirectories).toEqual({
            "/allowed/*": "allow",
        })
    })

    test("loadAutocodeConfig reads singular external_directory object rules", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                permission: {
                    external_directory: {
                        "/native/*": "allow",
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.externalDirectories).toEqual({
            "/native/*": "allow",
        })
    })

    test("loadAutocodeConfig reads singular external_directory string rules", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                permission: {
                    external_directory: "ask",
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.externalDirectories).toEqual({
            "*": "ask",
        })
    })

    test("loadAutocodeConfig loads ancestor configs upward with closer directory overrides", async () => {
        const fs = makeFs({
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                permission: {
                    external_directory: {
                        "/shared/*": "deny",
                        "/worktree/*": "allow",
                    },
                },
            }),
            "/wt/packages/.opencode/autocode.jsonc": JSON.stringify({
                permission: {
                    external_directory: {
                        "/packages/*": "ask",
                        "/shared/*": "allow",
                    },
                },
            }),
            "/wt/packages/app/.opencode/autocode.jsonc": JSON.stringify({
                permission: {
                    external_directory: {
                        "/app/*": "allow",
                        "/shared/*": "ask",
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt/packages/app", fs)

        expect(result.externalDirectories).toEqual({
            "/worktree/*": "allow",
            "/packages/*": "ask",
            "/app/*": "allow",
            "/shared/*": "ask",
        })
    })

    test("loadAutocodeConfig reads exact outside directory config without unrelated parents", async () => {
        const outsideParentConfigPath = "/outside/.opencode/autocode.jsonc"
        const readPaths: string[] = []
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                permission: {
                    external_directory: {
                        "/global/*": "allow",
                    },
                },
            }),
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                permission: {
                    external_directory: {
                        "/worktree/*": "ask",
                    },
                },
            }),
            [outsideParentConfigPath]: JSON.stringify({
                permission: {
                    external_directory: {
                        "/outside-parent/*": "deny",
                    },
                },
            }),
            "/outside/project/.opencode/autocode.jsonc": JSON.stringify({
                permission: {
                    external_directory: {
                        "/outside-project/*": "allow",
                    },
                },
            }),
        }, [], readPaths)

        const result = await loadAutocodeConfig("/wt", "/outside/project", fs)

        expect(result.externalDirectories).toEqual({
            "/global/*": "allow",
            "/worktree/*": "ask",
            "/outside-project/*": "allow",
        })
        expect(result.externalDirectories["/outside-parent/*"]).toBeUndefined()
        expect(readPaths).not.toContain(outsideParentConfigPath)
    })

    test("collectExternalDirectories accepts native external_directory action and object rules", () => {
        expect(collectExternalDirectories("allow")).toEqual({
            "*": "allow",
        })
        expect(collectExternalDirectories({
            "/allowed/*": "allow",
            "/invalid/*": "maybe",
        })).toEqual({
            "/allowed/*": "allow",
        })
    })

    test("existing local files still override global config", async () => {
        const fs = makeFs({
            [globalAutocodeConfigPath()]: JSON.stringify({
                permission: {
                    external_directory: {
                        "/shared/*": "deny",
                        "/global/*": "allow",
                    },
                },
            }),
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                permission: {
                    external_directory: {
                        "/shared/*": "allow",
                    },
                },
            }),
            "/dir/.opencode/autocode.jsonc": JSON.stringify({
                permission: {
                    external_directory: {
                        "/shared/*": "ask",
                    },
                },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/dir", fs)

        expect(result.externalDirectories).toEqual({
            "/global/*": "allow",
            "/shared/*": "ask",
        })
    })

    test("buildAgents applies centralized rules from original actions and question ask capability", () => {
        const agents = buildAgents({
            "/allowed/*": "allow",
            "/review/*": "ask",
            "/blocked/*": "deny",
        })
        expect(getPermissionRule(agents.design?.permission, "external_directory")).toEqual({
            "*": "ask",
            "/allowed/*": "allow",
            "/review/*": "ask",
            "/blocked/*": "deny",
        })
        expect(getPermissionRule(agents.execute_os?.permission, "external_directory")).toEqual({
            "*": "allow",
            "/allowed/*": "allow",
            "/review/*": "deny",
            "/blocked/*": "deny",
        })
        expect(getPermissionRule(agents.assist?.permission, "external_directory")).toEqual({
            "*": "ask",
            "/allowed/*": "allow",
            "/review/*": "ask",
            "/blocked/*": "deny",
        })
        expect(getPermissionRule(agents.query_code?.permission, "external_directory")).toEqual({
            "*": "deny",
            "/allowed/*": "allow",
            "/review/*": "deny",
            "/blocked/*": "deny",
        })
        expect(getPermissionRule(agents.auto_general?.permission, "task_external")).toEqual({
            "*": "allow",
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
                    task_external: "ask",
                },
            },
            question_ask: {
                permission: {
                    external_directory: "ask",
                    question: "ask",
                    task_external: "ask",
                },
            },
            question_deny: {
                permission: {
                    external_directory: "ask",
                    question: "deny",
                    task_external: "ask",
                },
            },
            action_allow: {
                permission: {
                    external_directory: "allow",
                    task_external: "allow",
                },
            },
            action_deny: {
                permission: {
                    external_directory: "deny",
                    question: "allow",
                    task_external: "deny",
                },
            },
            object_rules: {
                permission: {
                    external_directory: {
                        "*": "ask",
                        "/source-allow/*": "allow",
                        "/source-deny/*": "deny",
                    },
                    task_external: {
                        "*": "ask",
                        "/source-allow/*": "allow",
                        "/source-deny/*": "deny",
                    },
                },
            },
            task_external_source: {
                permission: {
                    question: "allow",
                    task_external: "ask",
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
        expect(getPermissionRule(agents.question_ask?.permission, "task_external")).toEqual({
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
        expect(getPermissionRule(agents.action_deny?.permission, "task_external")).toEqual({
            "*": "deny",
            "/configured-allow/*": "allow",
            "/configured-ask/*": "ask",
            "/configured-deny/*": "deny",
        })
        expect(getPermissionRule(agents.object_rules?.permission, "external_directory")).toEqual({
            "*": "deny",
            "/source-allow/*": "allow",
            "/source-deny/*": "deny",
            "/configured-allow/*": "allow",
            "/configured-ask/*": "deny",
            "/configured-deny/*": "deny",
        })
        expect(getPermissionRule(agents.task_external_source?.permission, "external_directory")).toEqual({
            "*": "ask",
            "/configured-allow/*": "allow",
            "/configured-ask/*": "ask",
            "/configured-deny/*": "deny",
        })
    })
})

describe("sandbox config", () => {
    test("loadAutocodeConfig parses hidden sandbox sync and distro cache config", async () => {
        for (const syncMethod of ["auto", "overlayfs", "reflink", "copy"] as const) {
            const fs = makeFs({
                "/wt/.opencode/autocode.jsonc": JSON.stringify({
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
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
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
            "/wt/.opencode/autocode.jsonc": JSON.stringify({
                autocode: { sandbox: { sync_method: "reflink", distro: { cache_path: "/worktree/cache" } } },
            }),
        })

        const result = await loadAutocodeConfig("/wt", "/wt", fs)

        expect(result.sandbox).toEqual({ sync_method: "reflink", distro_cache_path: "/worktree/cache", distro_expire: "never" })
    })
})

describe("agent workflow wiring", () => {
    test("keeps canonical auto and assist agents without removed workflow variants", () => {
        const agents = buildAgents()

        expect(agents.auto).toBeDefined()
        expect(agents.assist).toBeDefined()
        expect(Object.keys(agents).filter((name) => name.startsWith("auto-") || name.startsWith("assist-"))).toEqual([])
    })

    test("keeps current canonical permissions on primary workflow agents", () => {
        const agents = buildAgents()

        expect(getTaskPermissionRule(agents.assist?.permission, "auto*")).toBe("deny")
        expect(getTaskPermissionRule(agents.auto?.permission, "auto*")).toBe("allow")
        expect(getPermissionRule(agents.assist?.permission, "question")).toBe("allow")
        expect(getPermissionRule(agents.auto?.permission, "question")).toBeUndefined()
    })

    test("does not register legacy act or ask primary agents", () => {
        const agents = buildAgents()

        expect(agents.act).toBeUndefined()
        expect(agents.ask).toBeUndefined()
    })
})
