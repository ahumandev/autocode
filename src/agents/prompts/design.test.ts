import { describe, expect, test } from "bun:test"
import { designPrompt } from "./design"

describe("designPrompt", () => {
    test("advises job execution after design review", () => {
        expect(designPrompt).toContain('`label` = "🤖 Execute Autonomously"')
        expect(designPrompt).toContain('`label` = "🧑‍💻 Execute Interactively"')
        expect(designPrompt).toContain('"🤖 Execute Autonomously": call `autocode_job_execute` tool with agent `auto`.')
        expect(designPrompt).toContain('"🧑‍💻 Execute Interactively": call `autocode_job_execute` tool with agent `assist`.')
        expect(designPrompt).toContain("User revision instruction or cancelled question")
        expect(designPrompt).toContain("then ask this question again")
    })
})
