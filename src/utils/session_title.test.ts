import { describe, expect, test } from "bun:test"
import { cleanSessionTitleSuffix, formatSessionTitleForAgent, formatSessionTitleWithStatus } from "./session_title"

describe("session title utilities", () => {
    test("removes parenthesized suffixes and later text", () => {
        expect(cleanSessionTitleSuffix("Feature work (2026-08-18 14:30)")).toBe("Feature work")
        expect(cleanSessionTitleSuffix("Feature work (critical issue) stale text")).toBe("Feature work")
    })

    test("formats agent suffixes without duplicating matching suffix", () => {
        expect(formatSessionTitleForAgent("Feature work (2026-08-18 14:30)", "design")).toBe("Feature work (design)")
        expect(formatSessionTitleForAgent("Feature work (design)", "design")).toBe("Feature work (design)")
    })

    test("replaces repeated statuses and trailing text with one status", () => {
        expect(formatSessionTitleWithStatus("Name (status 1) (status 2) suffix", "new")).toBe("Name (new)")
    })
})
