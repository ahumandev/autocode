const retryCounts = new Map<string, number>()

function sortValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => sortValue(item, seen))
    }

    if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
            return "[Circular]"
        }

        seen.add(value)

        return Object.keys(value)
            .sort((left, right) => left.localeCompare(right))
            .reduce<Record<string, unknown>>((result, key) => {
                const entry = (value as Record<string, unknown>)[key]
                result[key] = sortValue(entry, seen)
                return result
            }, {})
    }

    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
        return String(value)
    }

    return value
}

export function flattenError(error: any): string {
    if (error instanceof Error) {
        if (error.name && error.name !== "Error" && error.message) {
            return `${error.name}: ${error.message}`
        }

        return error.message || error.name || "Unknown error"
    }

    if (typeof error === "string") {
        return error
    }

    if (error === null) {
        return "null"
    }

    if (error === undefined) {
        return "undefined"
    }

    if (typeof error === "object") {
        return JSON.stringify(sortValue(error))
    }

    return String(error)
}

export function createErrorResponse(failedAction: string, error: any, instruction: string): string {
    return JSON.stringify({
        failedAction,
        error: flattenError(error),
        instruction,
    })
}

export function createAbortResponse(failedAction: string, error: any): string {
    return createErrorResponse(failedAction, error, `
Immediately ABORT your flow and advise user what failed as follow:
    - list prior actions as bullet points (80 words max per point)
    - mention exact error that caused this failure
    - use markdown code blocks where appropriate to format logs/output/config 
    - use emojis to make user attend to important info
`)
}

export function createRetryResponse(failedAction: string, error: any, correctiveAction: string): string {
    const key = JSON.stringify([failedAction, correctiveAction])
    const retries = (retryCounts.get(key) ?? 0) + 1

    retryCounts.set(key, retries)

    if (retries > 5) {
        return createAbortResponse(failedAction, error)
    }

    return createErrorResponse(failedAction, error, correctiveAction)
}

export function createLifecycleJobRequiredRetryResponse(failedAction: string, subject?: string): string {
    const target = subject?.trim()
        ? `No planned job directory was found in .agents/jobs/* for ${subject}.`
        : "No planned job directory was found in .agents/jobs/* for the current session."

    return createRetryResponse(
        failedAction,
        `${target} This tool requires a lifecycle job directory.`,
        "Switch to a lifecycle job directory under .agents/jobs/*, then retry this tool."
    )
}

export function resetRetryCounts(): void {
    retryCounts.clear()
}
