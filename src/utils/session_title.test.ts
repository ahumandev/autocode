import { describe, expect, test } from "bun:test"
import { cleanSessionTitleSuffix, formatSessionTitleForAgent } from "./session_title"

describe("session title utilities", () => {
    test("removes exact timestamp suffixes and preserves unrelated parentheses", () => {
        expect(cleanSessionTitleSuffix("Feature work (2026-08-18 14:30)")).toBe("Feature work")
        expect(cleanSessionTitleSuffix("Feature work (critical issue)")).toBe("Feature work (critical issue)")
    })

    test("formats agent suffixes without duplicating matching suffix", () => {
        expect(formatSessionTitleForAgent("Feature work (2026-08-18 14:30)", "design")).toBe("Feature work (design)")
        expect(formatSessionTitleForAgent("Feature work (design)", "design")).toBe("Feature work (design)")
    })
})
