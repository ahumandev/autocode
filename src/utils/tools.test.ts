import { beforeEach, describe, expect, test } from "bun:test"
import { createRetryResponse, flattenError, resetRetryCounts } from "./tools"

function parseResponse(response: string): Record<string, string> {
    return JSON.parse(response) as Record<string, string>
}

describe("tools", () => {
    beforeEach(() => {
        resetRetryCounts()
    })

    test("normalizes supported error values and sorts object keys", () => {
        const namedError = new TypeError("wrong type")
        const cyclic: { self?: unknown } = {}
        cyclic.self = cyclic

        expect(flattenError(new Error("failed"))).toBe("failed")
        expect(flattenError(namedError)).toBe("TypeError: wrong type")
        expect(flattenError("failed")).toBe("failed")
        expect(flattenError(null)).toBe("null")
        expect(flattenError(undefined)).toBe("undefined")
        expect(flattenError(42)).toBe("42")
        expect(flattenError({ z: 1, a: { d: 2, b: 3 } })).toBe('{"a":{"b":3,"d":2},"z":1}')
        expect(flattenError(cyclic)).toBe('{"self":"[Circular]"}')
        expect(flattenError(1n)).toBe("1")
        expect(flattenError(Symbol("failed"))).toBe("Symbol(failed)")
    })

    test("returns retry response for attempts one through five and aborts sixth", () => {
        for (let attempt = 1; attempt <= 5; attempt += 1) {
            expect(parseResponse(createRetryResponse("action", "failed", "Retry now."))).toEqual({
                failedAction: "action",
                error: "failed",
                instruction: "Retry now.",
            })
        }

        const aborted = parseResponse(createRetryResponse("action", "failed", "Retry now."))
        expect(aborted.failedAction).toBe("action")
        expect(aborted.error).toBe("failed")
        expect(aborted.instruction).toContain("Immediately ABORT your flow")
    })

    test("isolates retry keys and reset clears retry counts", () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            createRetryResponse("action", "failed", "Retry first.")
        }

        expect(parseResponse(createRetryResponse("other-action", "failed", "Retry first."))).toEqual({
            failedAction: "other-action",
            error: "failed",
            instruction: "Retry first.",
        })
        expect(parseResponse(createRetryResponse("action", "failed", "Retry second."))).toEqual({
            failedAction: "action",
            error: "failed",
            instruction: "Retry second.",
        })

        resetRetryCounts()
        expect(parseResponse(createRetryResponse("action", "failed", "Retry first."))).toEqual({
            failedAction: "action",
            error: "failed",
            instruction: "Retry first.",
        })
    })
})
