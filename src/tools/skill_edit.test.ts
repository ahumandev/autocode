import { describe, expect, test } from "bun:test"
import { AGENT_SKILL_MAP } from "./skill_edit"

describe("skill_edit", () => {
    describe("generic skill names", () => {
        const unmappedAgents = ["document-conventions", "document-code", "document-install", "document-env", "document-prd", "document-ux", "memory", "primary"]

        test("AGENT_SKILL_MAP is empty and retired agents and memory are unmapped", () => {
            expect(AGENT_SKILL_MAP).toEqual({})
            for (const agent of unmappedAgents) {
                expect(AGENT_SKILL_MAP[agent]).toBeUndefined()
            }
        })
    })
})
