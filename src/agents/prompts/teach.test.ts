import { describe, expect, test } from "bun:test"
import { assistPrompt } from "./assist"
import { executeDocumentPrompt } from "./execute_document"
import { teachPrompt } from "./teach"
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
    assignmentTaskTrackingRules,
    focusedResearchSelectionRules,
    taskResultReportingRules,
    obviousFailureRecoveryRules,
    userCommunicationRules,
    questioningRules,
]

describe("teachPrompt", () => {
    test("consumes shared collaboration fragments in teaching workflow order", () => {
        let previousPosition = -1

        for (const fragment of collaborationFragments) {
            const position = teachPrompt.indexOf(fragment)
            expect(position).toBeGreaterThan(previousPosition)
            previousPosition = position
        }
    })

    test("consumes shared collaboration responsibility and subagent rules", () => {
        for (const fragment of [
            delegationStatusRules,
            nextActionAdvisoryRules,
            subagentCollaborationRules,
            userCollaborationResponsibilitiesRules,
        ]) {
            expect(teachPrompt).toContain(fragment)
        }
    })

    test("orders research, manual guidance, dependent checkpoints, and confirmation after workflow definition", () => {
        const workflowSteps = [
            "## Workflow",
            "1. Define",
            "2. Research",
            "3. Give user manual",
            "State prerequisites before actions.",
            "Give numbered, ordered actions. Each action includes expected outcome.",
            "Give exact verification commands and expected results.",
            "Give user-manual recovery guidance for failed verification.",
            "Stop and wait for user output at meaningful checkpoints when later actions depend on it.",
            "4. Treat implementation, verification, and completion as unknown until user confirms results.",
            "## Communication",
        ]
        let previousPosition = -1

        for (const step of workflowSteps) {
            const position = teachPrompt.indexOf(step)
            expect(position).toBeGreaterThan(previousPosition)
            previousPosition = position
        }
    })

    test("requires exact verification commands and limits delegation to research-only agents", () => {
        for (const requirement of [
            "Give exact verification commands and expected results.",
            "Delegate research only to `query*` agents or exact `auto_research`.",
            "Repeat research only through `query*` agents or exact `auto_research`.",
            "Never delegate implementation, edits, tests, commands, or other project changes.",
            "Apply recovery only to research tasks; never correct project files or instruct an agent to do so.",
        ]) {
            expect(teachPrompt).toContain(requirement)
        }
    })

    test("forbids project-change, action, result, and completion claims before user confirmation", () => {
        expect(teachPrompt).toContain("You never make, delegate, or claim project changes.")
        expect(teachPrompt).toContain("Treat implementation, verification, and completion as unknown until user confirms results.")
        expect(teachPrompt).toContain("Never claim you acted, a command ran, a result passed, or work completed without user confirmation.")
        expect(teachPrompt).toContain("State unverified facts explicitly.")
    })

    test("stays distinct from assist implementation delegation guidance", () => {
        expect(teachPrompt).not.toBe(assistPrompt)
        expect(teachPrompt).not.toContain(implementationDefinitions)
        expect(teachPrompt).not.toContain("Your primary responsibility is to `task` subagents to solve user PROBLEMS.")
        expect(teachPrompt).toContain("- Subagents gather info (not your job - you just `task` them)")
    })

    test("excludes documentation-agent identity and delegation guidance", () => {
        expect(teachPrompt).not.toBe(executeDocumentPrompt)
        expect(teachPrompt).not.toContain("# Document Agent")
        expect(teachPrompt).not.toContain("- You maintain agent/project memory documentation by delegating to specialized document_* subagents.")
    })
})
