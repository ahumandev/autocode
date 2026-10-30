import { describe, expect, test } from "bun:test"
import { buildAgents, type AutocodeAgentConfig } from "./index"
import { createPlatformCapabilities } from "../utils/platform"
import { permissionEffect } from "../utils/permissions"

function permissionRule(permission: AutocodeAgentConfig["permissions"], key: string): unknown {
    if (!permission) return undefined
    const rules = permission.filter((rule) => rule.action === key)
    if (rules.length === 0) return undefined
    return rules.length === 1 && rules[0].resource === "*" ? rules[0].effect
        : Object.fromEntries(rules.map((rule) => [rule.resource, rule.effect]))
}

function getSkillRule(agent: AutocodeAgentConfig | undefined, skillName: string): unknown {
    return agent?.permissions?.findLast((rule) => rule.action === "skill" && rule.resource === skillName)?.effect
}

function getSkillObject(agent: AutocodeAgentConfig | undefined): Record<string, unknown> | undefined {
    if (!agent?.permissions?.some((rule) => rule.action === "skill")) return undefined
    return Object.fromEntries(agent.permissions.filter((rule) => rule.action === "skill").map((rule) => [rule.resource, rule.effect]))
}

describe("buildAgents skill permissions", () => {
    test("keeps static execute-os skill permissions", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"))

        const executeOsSkill = getSkillObject(agents["execute-os"])
        expect(executeOsSkill).toEqual({
            "*": "deny",
            "execute-install": "allow",
            "execute-sandbox": "allow",
        })
        expect(getSkillRule(agents["execute-os"], "learned-permissions*")).toBeUndefined()
        expect(permissionRule(agents["execute-os"]?.permissions, "learn")).toBeUndefined()
    })

    test("does not grant unregistered skills to category agents", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, undefined, { balanced: {}, smart: {} })

        for (const agentName of ["execute-os", "execute-script", "execute-code", "assist", "auto", "design", "auto-test"]) {
            expect(getSkillRule(agents[agentName], "unregistered-skill")).toBeUndefined()
            expect(permissionEffect(agents[agentName]?.permissions, "skill", "unregistered-skill")).toBe("deny")
        }
    })

    test("keeps static execute-code skill and edit permissions", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"))

        expect(getSkillRule(agents["execute-code"], "code*")).toBe("allow")
        expect(permissionEffect(agents["execute-code"]?.permissions, "skill", "code-java")).toBe("allow")
        expect(permissionRule(agents["execute-code"]?.permissions, "edit")).toBe("allow")
    })

    test("omits explicit third-party skill grants while retaining wildcard policy", () => {
        const removedSkillsByAgent: Record<string, string[]> = {
            advise: ["codebase-design", "ui-craft"],
            assist: ["codebase-design", "ui-craft"],
            design: ["codebase-design"],
            "auto-feature": ["codebase-design", "vue-best-practices", "ui-craft"],
            "auto-refactor": ["codebase-design"],
            "execute-code": ["angular-developer", "java-junit", "javascript-typescript-jest", "nitro", "nuxt", "tailwindcss", "vitest"],
            "execute-os": ["angular-new-app"],
            "query-skills": ["vue-best-practices", "ui-craft"],
        }
        const agents = buildAgents(createPlatformCapabilities("linux"))

        for (const [agentName, skillNames] of Object.entries(removedSkillsByAgent)) {
            for (const skillName of skillNames) {
                expect(getSkillRule(agents[agentName], skillName)).toBeUndefined()
            }
        }
        for (const agentName of ["auto-feature", "auto-refactor", "execute-code"]) {
            expect(getSkillRule(agents[agentName], "code*")).toBe("allow")
            expect(permissionEffect(agents[agentName]?.permissions, "skill", "code-java")).toBe("allow")
        }
    })
})
