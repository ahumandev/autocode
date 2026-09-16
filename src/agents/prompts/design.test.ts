import { describe, expect, test } from "bun:test"
import { designPrompt } from "./design"

describe("designPrompt", () => {
    test("advises job execution after design review", () => {
        expect(designPrompt).toContain('`label` = "🤖 Execute Autonomously"')
        expect(designPrompt).toContain('`label` = "🧑‍💻 Execute Interactively"')
        expect(designPrompt).toContain("call `autocode_session_create`")
        expect(designPrompt).toContain('agent="auto"')
        expect(designPrompt).toContain('agent="assist"')
        expect(designPrompt).toContain("User revision instruction or cancelled question")
        expect(designPrompt).toContain("then ask this question again")
    })
})
