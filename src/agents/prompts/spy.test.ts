import { describe, expect, test } from "bun:test"
import { spyPrompt } from "./spy"

describe("spyPrompt", () => {
    test("requires evidence-based safety guidance before manual changes", () => {
        for (const rule of [
            "Provide guidance and report evidence for project safety decisions.",
            "Discover solution before giving implementation steps:",
            "Gather all critical facts with permitted tools.",
            "Only 1 modification task to complete ASSIGNMENT: then tell user next task with emojis in Concise English (max 20 words)",
        ]) {
            expect(spyPrompt).toContain(rule)
        }
    })

    test("keeps guidance in current direct session", () => {
        expect(spyPrompt).not.toContain("autocode_session_create")
        expect(spyPrompt).not.toContain("autocode_job_execute")
    })
})
