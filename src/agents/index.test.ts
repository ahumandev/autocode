import { describe, expect, test } from "bun:test"
import { applyExternalDirectoryPolicy, applySandboxPlatformPolicy, buildAgents, type AutocodeAgentConfig } from "./index"

function permissionRule(permission: AutocodeAgentConfig["permission"], key: string): unknown {
    if (!permission || typeof permission === "string") return undefined
    return (permission as Record<string, unknown>)[key]
}

const sandboxToolNames = ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy"]
const executeRestToolNames = ["autocode_rest", "autocode_rest_grep", "autocode_rest_response_eval", "autocode_rest_response_read"]

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
        expect(permissionRule(agents.temp_review_reject?.permission, "autocode_job_shelve")).toBe("allow")
        expect(permissionRule(agents.temp_review_reject?.permission, "git_reset")).toBe("allow")
        expect(permissionRule(agents.temp_shelve?.permission, "git_reset")).toBeUndefined()
    })

    test("buildAgents exposes execute_rest as REST-only worker and allows supported orchestration tasks to call it", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })

        expect(agents.execute_rest?.mode).toBe("subagent")
        expect(agents.execute_rest?.hidden).toBe(true)
        expect(agents.execute_rest?.tier).toBe("balanced")
        expect(agents.execute_rest?.temperature).toBe(0.1)
        expect(permissionRule(agents.execute_rest?.permission, "*")).toBe("deny")
        for (const toolName of executeRestToolNames) {
            expect(permissionRule(agents.execute_rest?.permission, toolName)).toBe("allow")
        }
        expect(permissionRule(agents.execute_rest?.permission, "doom_loop")).toBe("deny")
        expect(agents.execute_rest?.prompt).toContain("autocode_rest")
        expect(agents.execute_rest?.prompt).toContain("autocode_rest_response_read")
        expect(agents.execute_rest?.prompt).toContain("autocode_rest_grep")
        expect(agents.execute_rest?.prompt).toContain("autocode_rest_response_eval")
        expect(agents.execute_rest?.prompt).toContain("GET, POST, PUT, PATCH, DELETE")
        expect(agents.execute_rest?.prompt).toContain("Values in `query` map override same query keys already in URL")
        expect(agents.execute_rest?.prompt).toContain("truncated: true")
        expect(agents.execute_rest?.prompt).toContain("full_response: false")
        expect(agents.execute_rest?.prompt).toContain("Never dump full raw REST result unless user specifically asks")
        expect(agents.execute_rest?.prompt).toContain("Caveman English")
        expect(agents.execute_rest?.prompt).toContain("ask user confirmation")
        expect(agents.execute_rest?.prompt).toContain("Do not leak sensitive headers or body unless user explicitly requested")
        expect(permissionRule(agents.auto_review_api?.permission, "task")).toEqual(expect.objectContaining({
            execute_rest: "allow",
        }))
    })

    test("execute_rest prompt examples use strict JSON object text", () => {
        const agents = buildAgents({}, { platform: "linux", env: {}, bwrapUsable: true })
        const prompt = String(agents.execute_rest?.prompt ?? "")
        const examplesMatch: RegExpMatchArray | null = prompt.match(/### Examples([\s\S]+?)## Follow-up tools for saved responses/)
        const examplesSection = examplesMatch?.[1] ?? ""
        const spans = Array.from(examplesSection.matchAll(/`(\{[^`]+\})`/g), (match): string => match[1]!)
        const legacyPattern = /[{,]\s*(url|method|query|headers|body|timeout|page|content-type|name|active)\s*:/

        expect(prompt).toContain('{ "url": "https://api.example.com/users", "method": "GET", "query": { "page": "1" }, "timeout": 5000 }')
        expect(prompt).toContain('{ "url": "https://api.example.com/users", "method": "POST", "headers": { "content-type": "application/json" }, "body": { "name": "Ann" }, "timeout": 5000 }')
        expect(prompt).toContain('{ "url": "https://api.example.com/users/1", "method": "PUT", "headers": { "content-type": "application/json" }, "body": { "name": "Ann 2" }, "timeout": 5000 }')
        expect(prompt).toContain('{ "url": "https://api.example.com/users/1", "method": "PATCH", "headers": { "content-type": "application/json" }, "body": { "active": true }, "timeout": 5000 }')
        expect(prompt).toContain('{ "url": "https://api.example.com/users/1", "method": "DELETE", "timeout": 5000 }')
        expect(spans).toHaveLength(5)

        const parsedMethods = spans.map((span) => {
            expect(span).not.toMatch(legacyPattern)
            return String((JSON.parse(span) as { method?: unknown }).method)
        })

        expect(parsedMethods).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"])
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
