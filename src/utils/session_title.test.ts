import { describe, expect, test } from "bun:test"
import { jobStatuses } from "./jobs"
import { cleanSessionTitleSuffix, formatSessionTitleForAgent, formatSessionTitleForJobStatus } from "./session_title"

function isCanonicalStatus(value: string): boolean {
    return (jobStatuses as readonly string[]).includes(value)
}

describe("session title utilities", () => {
    test("removes every trailing canonical status suffix", () => {
        for (const status of jobStatuses) {
            expect(cleanSessionTitleSuffix(`Feature work (${status})`, isCanonicalStatus)).toBe("Feature work")
        }
    })

    test("removes exact timestamp suffixes and preserves unrelated parentheses", () => {
        expect(cleanSessionTitleSuffix("Feature work (2026-08-18 14:30)", isCanonicalStatus)).toBe("Feature work")
        expect(cleanSessionTitleSuffix("Feature work (critical issue)", isCanonicalStatus)).toBe("Feature work (critical issue)")
    })

    test("appends valid status only for auto without duplicate suffixes", () => {
        expect(formatSessionTitleForJobStatus("Feature work (executing)", "auto", "executing", isCanonicalStatus)).toBe("Feature work (executing)")
        expect(formatSessionTitleForJobStatus("Feature work (executing) (executing)", "auto", "executing", isCanonicalStatus)).toBe("Feature work (executing)")
    })

    test("cleans status suffixes without appending for non-auto agents", () => {
        for (const agent of ["assist", "advise", "design"]) {
            expect(formatSessionTitleForJobStatus("Feature work (review)", agent, "review", isCanonicalStatus)).toBe("Feature work")
        }
    })

    test("formats agent suffixes without duplicating matching suffix", () => {
        expect(formatSessionTitleForAgent("Feature work (2026-08-18 14:30)", "design", isCanonicalStatus)).toBe("Feature work (design)")
        expect(formatSessionTitleForAgent("Feature work (design)", "design", isCanonicalStatus)).toBe("Feature work (design)")
    })
})
