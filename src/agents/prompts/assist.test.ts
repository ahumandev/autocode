import { describe, expect, test } from "bun:test"
import { assistPrompt } from "./assist"
import { implementationDefinitions } from "../rules/definitions"
import {
    assignmentTaskTrackingRules,
    delegationStatusRules,
    focusedResearchSelectionRules,
    nextActionAdvisoryRules,
    obviousFailureRecoveryRules,
    questioningRules,
    subagentCollaborationRules,
    taskResultReportingRules,
    userCollaborationResponsibilitiesRules,
    userCommunicationRules,
} from "../rules/collaboration"

const collaborationFragments: string[] = [
    delegationStatusRules,
    assignmentTaskTrackingRules,
    nextActionAdvisoryRules,
    subagentCollaborationRules,
    userCollaborationResponsibilitiesRules,
    focusedResearchSelectionRules,
    taskResultReportingRules,
    userCommunicationRules,
    obviousFailureRecoveryRules,
    questioningRules,
]

const assistOnlyMarkers: string[] = [
    implementationDefinitions,
    "execute_code",
    "assist-troubleshoot",
    "git_commit",
    "teach",
]

describe("assistPrompt", () => {
    test("consumes shared collaboration fragments in workflow order", () => {
        let previousPosition = -1

        for (const fragment of collaborationFragments) {
            const position = assistPrompt.indexOf(fragment)
            expect(position).toBeGreaterThan(previousPosition)
            previousPosition = position
        }
    })

    test("keeps assist-only implementation and workflow content out of shared fragments", () => {
        for (const fragment of collaborationFragments) {
            for (const marker of assistOnlyMarkers) {
                expect(fragment).not.toContain(marker)
            }
        }
    })

    test("keeps assist-only implementation and workflow markers in prompt", () => {
        for (const marker of [implementationDefinitions, "assist-troubleshoot", "git_commit"]) {
            expect(assistPrompt).toContain(marker)
        }
    })

    test("keeps delegated workflow and permission policy wording", () => {
        expect(assistPrompt).toContain("Your primary responsibility is to `task` subagents to solve user PROBLEMS.")
        expect(assistPrompt).toContain(subagentCollaborationRules)
        expect(assistPrompt).toContain("- Execute DANGEROUS OPERATIONS")
        expect(assistPrompt).toContain("Call `autocode_swap_manual` with agent `temp_manual` when manual intervention is required.")
        expect(assistPrompt).toContain("- Only call `git_commit` tool on user request.")
    })
})
