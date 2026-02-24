import { trackFailure, resetTool, MAX_RETRIES } from "./retry-tracker"

// ─── response helpers ─────────────────────────────────────────────────────────

/**
 * Resets the retry counter for the tool and returns the provided result.
 * Call this on every successful tool execution so a subsequent failure starts
 * fresh rather than inheriting counts from a previous partial run.
 *
 * @param sessionID Agent session ID (from `context.sessionID`)
 * @param toolName  Name of the tool that succeeded
 * @param result    Success payload — objects are JSON-serialized; strings pass through as-is
 */
export function successResponse(sessionID: string, toolName: string, result: unknown = { success: true }): string {
    resetTool(sessionID, toolName)
    return typeof result === "string" ? result : JSON.stringify(result)
}

/**
 * Returns a JSON error response instructing the agent to abort the workflow.
 * Use for internal system failures that are not the agent's fault.
 *
 * @param toolName Tool that failed
 * @param reason Human-readable description of what went wrong
 */
export function abortResponse(toolName: string, reason: string): string {
    return JSON.stringify({ error: `You **MUST ABORT** your workflow immediately and prompt the user to investigate the failure of the tool call '${toolName}' with reason: ${reason}` })
}

/**
 * Returns a JSON error response instructing the agent to retry the tool call
 * with corrected parameters. Internally tracks retry attempts via retry-tracker:
 * after `MAX_RETRIES` failed attempts for the same tool in the same session,
 * `onMaxRetries` is called instead of issuing another retry instruction.
 *
 * @param sessionID    Agent session ID (from `context.sessionID`)
 * @param toolName     Tool that should be retried
 * @param paramName    Parameter that was invalid
 * @param constraint   Description of what the parameter must satisfy
 * @param onMaxRetries Called when max retries is exceeded; defaults to an abort response
 */
export function retryResponse(
    sessionID: string,
    toolName: string,
    paramName: string,
    constraint: string,
    onMaxRetries: () => string = () =>
        abortResponse(toolName, `Tool failed with an invalid '${paramName}' parameter violating the constraint: ${constraint}`),
): string {
    const { shouldAbort } = trackFailure(sessionID, toolName)
    if (shouldAbort) {
        return onMaxRetries()
    }
    return JSON.stringify({ error: `Retry ${toolName} again with a valid ${paramName} parameter which must ${constraint}` })
}



// ─── parameter validators ─────────────────────────────────────────────────────
// Each validator returns null on pass or a complete JSON error response on failure.
// The returned string is ready to return directly from a tool's execute function.

/**
 * Validates that a string parameter is non-empty (not undefined, null, or blank).
 */
export function validateNonEmpty(
    value: string | undefined | null,
    sessionID: string,
    toolName: string,
    paramName: string,
): string | null {
    if (!value || value.trim() === "") {
        return retryResponse(sessionID, toolName, paramName, "not be empty")
    }
    return null
}

/**
 * Validates that a string parameter does not exceed a maximum number of words.
 * Words are split on whitespace and/or underscores.
 */
export function validateMaxWords(
    value: string,
    maxWords: number,
    sessionID: string,
    toolName: string,
    paramName: string,
): string | null {
    const words = value.trim().split(/[\s_]+/).filter(Boolean)
    if (words.length > maxWords) {
        return retryResponse(
            sessionID,
            toolName,
            paramName,
            `not exceed ${maxWords} words (${words.length} words were provided)`,
        )
    }
    return null
}

/**
 * Validates that a string parameter meets a minimum character length
 * (after trimming whitespace).
 */
export function validateMinLength(
    value: string,
    minLength: number,
    sessionID: string,
    toolName: string,
    paramName: string,
): string | null {
    if (value.trim().length < minLength) {
        return retryResponse(
            sessionID,
            toolName,
            paramName,
            `be at least ${minLength} character${minLength === 1 ? "" : "s"} long`,
        )
    }
    return null
}

/**
 * Validates that a string parameter does not exceed a maximum character length
 * (after trimming whitespace).
 */
export function validateMaxLength(
    value: string,
    maxLength: number,
    sessionID: string,
    toolName: string,
    paramName: string,
): string | null {
    if (value.trim().length > maxLength) {
        return retryResponse(
            sessionID,
            toolName,
            paramName,
            `not exceed ${maxLength} characters`,
        )
    }
    return null
}

/**
 * Validates that a string parameter matches a regular expression.
 *
 * @param pattern    Regex to test the value against
 * @param formatDesc Human-readable description of the expected format (shown in error)
 */
export function validateFormat(
    value: string,
    pattern: RegExp,
    formatDesc: string,
    sessionID: string,
    toolName: string,
    paramName: string,
): string | null {
    if (!pattern.test(value)) {
        return retryResponse(sessionID, toolName, paramName, `match the format: ${formatDesc}`)
    }
    return null
}

/**
 * Validates that a string contains at least one alphanumeric character after
 * lowercasing and stripping all non-alphanumeric characters.
 * Useful for validating name/identifier parameters before sanitization.
 */
export function validateHasAlphanumeric(
    value: string,
    sessionID: string,
    toolName: string,
    paramName: string,
): string | null {
    const stripped = value.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (stripped === "") {
        return retryResponse(
            sessionID,
            toolName,
            paramName,
            "contain at least one alphanumeric character (letters or digits)",
        )
    }
    return null
}

// ─── parameter formatters ─────────────────────────────────────────────────────

/** Converts a string to lowercase. */
export function toLowercase(value: string): string {
    return value.toLowerCase()
}

/**
 * Replaces every non-alphanumeric character with the given replacement
 * (default `_`). Assumes input is already lowercased.
 */
export function replaceSpecialChars(value: string, replacement = "_"): string {
    return value.replace(/[^a-z0-9]/g, replacement)
}

/**
 * Collapses consecutive underscores (two or more) to a single `_`.
 */
export function collapseUnderscores(value: string): string {
    return value.replace(/__+/g, "_")
}

/**
 * Strips leading and trailing underscores.
 */
export function stripEdgeUnderscores(value: string): string {
    return value.replace(/^_+|_+$/g, "")
}

/**
 * Normalizes a raw string into a lowercase, underscore-separated identifier:
 * 1. Trim whitespace
 * 2. Lowercase
 * 3. Replace non-alphanumeric chars with `_`
 * 4. Collapse consecutive underscores
 * 5. Strip leading / trailing underscores
 */
export function toIdentifier(value: string): string {
    let id = value.trim().toLowerCase()
    id = replaceSpecialChars(id)
    id = collapseUnderscores(id)
    id = stripEdgeUnderscores(id)
    return id
}
