import { describe, expect, test } from "bun:test"
import { applyExternalDirectoryPolicy, applySandboxPlatformPolicy, buildAgents, type AutocodeAgentConfig } from "./index"

function permissionRule(permission: AutocodeAgentConfig["permission"], key: string): unknown {
    if (!permission || typeof permission === "string") return undefined
    return (permission as Record<string, unknown>)[key]
}

const sandboxToolNames = ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy"]

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
        }, { platform: "linux", bwrapUsable: true })

        expect(agents.execute_sandbox?.disable).toBeUndefined()
        expect(permissionRule(agents.execute_sandbox?.permission, "autocode_sandbox_cli")).toBe("allow")
        expect(permissionRule(agents.wildcard_sandbox?.permission, "autocode_sandbox_*")).toBe("allow")
    })

    test("execute_sandbox allows native sandbox file tools", () => {
        const agents = buildAgents({}, { platform: "linux", bwrapUsable: true })

        for (const toolName of ["autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read"]) {
            expect(permissionRule(agents.execute_sandbox?.permission, toolName)).toBe("allow")
        }
        expect(permissionRule(agents.execute_sandbox?.permission, "autocode_sandbox_copy")).toEqual({ sandbox_target: "allow", local_target: "allow" })
    })

    test("buildAgents returns policy-applied definitions with current internal tier metadata", () => {
        const agents = buildAgents({
            "/configured/*": "allow",
        }, { platform: "linux", bwrapUsable: true })

        expect(agents.assist?.mode).toBe("primary")
        expect(agents.auto?.mode).toBe("primary")
        expect(agents.execute_sandbox?.mode).toBe("subagent")
        expect(agents.temp_session?.permission).toEqual(expect.objectContaining({ autocode_session_create: "allow" }))
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
})
