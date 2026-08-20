import { describe, expect, test } from "bun:test"
import { designPrompt } from "./design"

describe("designPrompt", () => {
    test("drafts discovered approach for review before execution", () => {
        expect(designPrompt).toContain("Choose best discovered accepted approach")
        expect(designPrompt).toContain("autocode_design_write")
        expect(designPrompt).toContain("[Review design.md]([job_path])")
        expect(designPrompt).toContain('`label` = "🤖 Execute Autonomously"')
        expect(designPrompt).toContain('`label` = "🧑‍💻 Execute Interactively"')
        expect(designPrompt).toContain('"🤖 Execute Autonomously": call `autocode_job_execute` tool with agent `auto`.')
        expect(designPrompt).toContain('"🧑‍💻 Execute Interactively": call `autocode_job_execute` tool with agent `assist`.')
        expect(designPrompt).toContain("User revision instruction or cancelled question")
        expect(designPrompt).toContain("then ask this question again")
    })
})
