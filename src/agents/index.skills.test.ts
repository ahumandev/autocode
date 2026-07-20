import { describe, expect, test } from "bun:test"
import { buildAgents, type AutocodeAgentConfig } from "./index"
import type { ExternalSkill } from "../utils/external"

function permissionRule(permission: AutocodeAgentConfig["permission"], key: string): unknown {
    if (!permission || typeof permission === "string") return undefined
    return (permission as Record<string, unknown>)[key]
}

function getSkillRule(agent: AutocodeAgentConfig | undefined, skillName: string): unknown {
    if (!agent?.permission || typeof agent.permission === "string") return undefined
    const skill = (agent.permission as Record<string, unknown>).skill
    if (!skill || typeof skill === "string") return undefined
    return (skill as Record<string, unknown>)[skillName]
}

function getSkillObject(agent: AutocodeAgentConfig | undefined): Record<string, unknown> | undefined {
    if (!agent?.permission || typeof agent.permission === "string") return undefined
    const skill = (agent.permission as Record<string, unknown>).skill
    if (!skill || typeof skill === "string") return undefined
    return skill as Record<string, unknown>
}

describe("buildAgents with external skills", () => {
    test("no external skills → no new permission.skill entries beyond the static rules", () => {
        // Run first while the static baseAgents is still untouched so the
        // snapshot reflects the canonical definition.
        const agents = buildAgents({}, undefined, [])

        const executeOsSkill = getSkillObject(agents.execute_os)
        expect(executeOsSkill).toEqual({
            "*": "deny",
            "execute-install": "allow",
            "execute-sandbox": "allow",
            "learned-corrections*": "allow",
            "learned-env*": "allow",
            "learned-permissions*": "allow",
            "skill-write": "allow"
        })
    })

    test("bash category → execute_os and execute_script get the rule, other agents do not", () => {
        const agents = buildAgents({}, undefined, [
            { category: "bash", skillName: "my-bash-skill", owner: "o", project: "p" },
        ])

        expect(getSkillRule(agents.execute_os, "my-bash-skill")).toBe("allow")
        expect(getSkillRule(agents.execute_script, "my-bash-skill")).toBe("allow")
        expect(getSkillRule(agents.execute_code, "my-bash-skill")).toBeUndefined()
        expect(getSkillRule(agents.assist, "my-bash-skill")).toBeUndefined()
    })

    test("code category → only execute_code gets the rule", () => {
        const agents = buildAgents({}, undefined, [
            { category: "code", skillName: "my-code-skill", owner: "o", project: "p" },
        ])

        expect(getSkillRule(agents.execute_code, "my-code-skill")).toBe("allow")
        expect(getSkillRule(agents.execute_os, "my-code-skill")).toBeUndefined()
        expect(getSkillRule(agents.execute_script, "my-code-skill")).toBeUndefined()
        expect(getSkillRule(agents.assist, "my-code-skill")).toBeUndefined()
    })

    test("design category → assist, auto, and design all get the rule (design gains permission.skill)", () => {
        const agents = buildAgents({}, undefined, [
            { category: "design", skillName: "my-design-skill", owner: "o", project: "p" },
        ])

        expect(getSkillRule(agents.assist, "my-design-skill")).toBe("allow")
        expect(getSkillRule(agents.auto, "my-design-skill")).toBe("allow")
        expect(getSkillRule(agents.design, "my-design-skill")).toBe("allow")

        // design previously had no permission.skill at all; after injection
        // it should have an object containing at least the new rule.
        const designSkill = getSkillObject(agents.design)
        expect(designSkill).toBeDefined()
        expect(designSkill!["my-design-skill"]).toBe("allow")
    })

    test("test category → only auto_test gets the rule", () => {
        const agents = buildAgents({}, undefined, [
            { category: "test", skillName: "my-test-skill", owner: "o", project: "p" },
        ])

        expect(getSkillRule(agents.auto_test, "my-test-skill")).toBe("allow")
        expect(getSkillRule(agents.execute_code, "my-test-skill")).toBeUndefined()
        expect(getSkillRule(agents.execute_os, "my-test-skill")).toBeUndefined()
        expect(getSkillRule(agents.assist, "my-test-skill")).toBeUndefined()
    })

    test("unknown category → no agent is modified (function is defensive)", () => {
        // Snapshot the static skill map for every agent before the call so the
        // assertion holds regardless of any prior test that mutated baseAgents.
        const baseline = buildAgents({}, undefined, [])
        const baselineSnapshot: Record<string, Record<string, unknown> | undefined> = {}
        for (const [agentName, agent] of Object.entries(baseline)) {
            baselineSnapshot[agentName] = getSkillObject(agent)
        }

        const agents = buildAgents({}, undefined, [
            { category: "bogus" as unknown as ExternalSkill["category"], skillName: "bogus-skill", owner: "o", project: "p" },
        ])

        for (const [agentName, agent] of Object.entries(agents)) {
            expect(getSkillObject(agent)).toEqual(baselineSnapshot[agentName])
            expect(getSkillRule(agent, "bogus-skill")).toBeUndefined()
        }
    })

    test("static rules are preserved after injection (execute_code keeps 'code*' = allow)", () => {
        const agents = buildAgents({}, undefined, [
            { category: "code", skillName: "injected-code-skill", owner: "o", project: "p" },
        ])

        // The static "code*" wildcard must still be present and set to "allow".
        expect(getSkillRule(agents.execute_code, "code*")).toBe("allow")
        // And the freshly-injected rule should also be there.
        expect(getSkillRule(agents.execute_code, "injected-code-skill")).toBe("allow")
        // Sanity: unrelated static entries on a different agent are untouched
        // (modulo any additions from earlier tests in this file).
        expect(permissionRule(agents.execute_code?.permission, "edit")).toBe("allow")
    })
})
