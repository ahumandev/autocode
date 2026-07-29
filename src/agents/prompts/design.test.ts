import { describe, expect, test } from "bun:test"
import { designPrompt } from "./design"

describe("designPrompt", () => {
    test("drafts discovered approach for review before execution", () => {
        expect(designPrompt).toContain("research discoveries carried by the research restart")
        expect(designPrompt).toContain("Choose best discovered accepted approach")
        expect(designPrompt).toContain("autocode_job_draft")
        expect(designPrompt).toContain("[Review plan.md]([job_path])")
        expect(designPrompt).toContain('`label` = "🤖 Execute Autonomously"')
        expect(designPrompt).toContain('`label` = "🧑‍💻 Execute Interactively"')
        expect(designPrompt).toContain('`label` = "🎓 Execute Manually"')
        expect(designPrompt).toContain("Teach user how to complete reviewed plan himself.")
        expect(designPrompt).toContain('"🎓 Execute Manually": call `autocode_job_execute` tool with agent `teach`.')
        expect(designPrompt).toContain("User revision instruction or cancelled question")
        expect(designPrompt).toContain("then ask this question again")
    })
})
