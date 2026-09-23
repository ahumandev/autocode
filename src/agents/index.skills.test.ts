import { describe, expect, test } from "bun:test"
import { buildAgents, type AutocodeAgentConfig } from "./index"
import type { ExternalSkill } from "../utils/external"
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

describe("buildAgents with external skills", () => {
    test("no external skills → no new permission.skill entries beyond the static rules", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"))

        const executeOsSkill = getSkillObject(agents["execute-os"])
        expect(executeOsSkill).toEqual({
            "*": "deny",
            "angular-new-app": "allow",
            "execute-install": "allow",
            "execute-sandbox": "allow",
        })
        expect(getSkillRule(agents["execute-os"], "learned-permissions*")).toBeUndefined()
        expect(permissionRule(agents["execute-os"]?.permissions, "learn")).toBe("allow")
    })

    test("bash category → execute-os and execute-script get the rule, other agents do not", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, undefined, [
            { category: "bash", skillName: "my-bash-skill", owner: "o", project: "p" },
        ])

        expect(getSkillRule(agents["execute-os"], "my-bash-skill")).toBe("allow")
        expect(getSkillRule(agents["execute-script"], "my-bash-skill")).toBe("allow")
        expect(getSkillRule(agents["execute-code"], "my-bash-skill")).toBeUndefined()
        expect(getSkillRule(agents.assist, "my-bash-skill")).toBeUndefined()
    })

    test("code category → only execute-code gets the rule", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, undefined, [
            { category: "code", skillName: "my-code-skill", owner: "o", project: "p" },
        ])

        expect(getSkillRule(agents["execute-code"], "my-code-skill")).toBe("allow")
        expect(getSkillRule(agents["execute-os"], "my-code-skill")).toBeUndefined()
        expect(getSkillRule(agents["execute-script"], "my-code-skill")).toBeUndefined()
        expect(getSkillRule(agents.assist, "my-code-skill")).toBeUndefined()
    })

    test("design category → assist, auto, and design all get the rule (design gains permission.skill)", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, undefined, [
            { category: "design", skillName: "my-design-skill", owner: "o", project: "p" },
        ], { balanced: {}, smart: {} })

        expect(getSkillRule(agents.assist, "my-design-skill")).toBe("allow")
        expect(getSkillRule(agents.auto, "my-design-skill")).toBe("allow")
        expect(getSkillRule(agents.design, "my-design-skill")).toBe("allow")

        // design previously had no permission.skill at all; after injection
        // it should have an object containing at least the new rule.
        const designSkill = getSkillObject(agents.design)
        expect(designSkill).toBeDefined()
        if (!designSkill) throw new Error("Expected design skill permissions")
        expect(designSkill["my-design-skill"]).toBe("allow")
    })

    test("test category → only auto-test gets the rule", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, undefined, [
            { category: "test", skillName: "my-test-skill", owner: "o", project: "p" },
        ])

        expect(getSkillRule(agents["auto-test"], "my-test-skill")).toBe("allow")
        expect(getSkillRule(agents["execute-code"], "my-test-skill")).toBeUndefined()
        expect(getSkillRule(agents["execute-os"], "my-test-skill")).toBeUndefined()
        expect(getSkillRule(agents.assist, "my-test-skill")).toBeUndefined()
    })

    test("unknown category → no agent is modified (function is defensive)", () => {
        const baseline = buildAgents(createPlatformCapabilities("linux"))
        const baselineSnapshot: Record<string, Record<string, unknown> | undefined> = {}
        for (const [agentName, agent] of Object.entries(baseline)) {
            baselineSnapshot[agentName] = getSkillObject(agent)
        }

        const agents = buildAgents(createPlatformCapabilities("linux"), {}, undefined, [
            { category: "bogus" as unknown as ExternalSkill["category"], skillName: "bogus-skill", owner: "o", project: "p" },
        ])

        for (const [agentName, agent] of Object.entries(agents)) {
            expect(getSkillObject(agent)).toEqual(baselineSnapshot[agentName])
            expect(getSkillRule(agent, "bogus-skill")).toBeUndefined()
        }
    })

    test("static rules are preserved after injection (execute-code keeps 'code*' = allow)", () => {
        const agents = buildAgents(createPlatformCapabilities("linux"), {}, undefined, [
            { category: "code", skillName: "injected-code-skill", owner: "o", project: "p" },
        ])

        // The static "code*" wildcard must still be present and set to "allow".
        expect(getSkillRule(agents["execute-code"], "code*")).toBe("allow")
        // And the freshly-injected rule should also be there.
        expect(getSkillRule(agents["execute-code"], "injected-code-skill")).toBe("allow")
        expect(permissionEffect(agents["execute-code"]?.permissions, "skill", "injected-code-skill")).toBe("allow")
        // Sanity: unrelated static entries on a different agent are untouched
        // (modulo any additions from earlier tests in this file).
        expect(permissionRule(agents["execute-code"]?.permissions, "edit")).toBe("allow")
    })
})
