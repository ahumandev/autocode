import { describe, expect, test } from "bun:test"
import { buildEnvVarName, normalizeEnvKey } from "./envkey"

describe("normalizeEnvKey", () => {
    test("trims and uppercases a basic key", () => {
        expect(normalizeEnvKey("reporting_db")).toBe("REPORTING_DB")
        expect(normalizeEnvKey("  RePoRtInG_123  ")).toBe("REPORTING_123")
    })

    test("uses default label 'key' when not provided", () => {
        expect(() => normalizeEnvKey("")).toThrow("Invalid key.")
    })

    test("uses provided label in default error message", () => {
        expect(() => normalizeEnvKey("", { label: "custom" })).toThrow("Invalid custom.")
    })

    test("allowHyphen=true accepts hyphen and replaces it with underscore", () => {
        expect(normalizeEnvKey("dev-box", { allowHyphen: true })).toBe("DEV_BOX")
        expect(normalizeEnvKey("a-b-c", { allowHyphen: true })).toBe("A_B_C")
    })

    test("allowHyphen=false rejects hyphen characters", () => {
        expect(() => normalizeEnvKey("dev-box", { allowHyphen: false })).toThrow("Invalid key.")
        expect(() => normalizeEnvKey("dev-box")).toThrow("Invalid key.")
    })

    test("empty input throws the provided error message verbatim", () => {
        const message = "Invalid db_key. Use only ASCII letters, digits, and underscores."
        expect(() => normalizeEnvKey("", { label: "db_key", errorMessage: message })).toThrow(message)
        expect(() => normalizeEnvKey("   ", { label: "db_key", errorMessage: message })).toThrow(message)
    })

    test("invalid characters throw the custom error message verbatim", () => {
        const message = "Invalid rest_key. Use only ASCII letters, digits, and underscores."
        expect(() => normalizeEnvKey("foo bar", { label: "rest_key", errorMessage: message })).toThrow(message)
        expect(() => normalizeEnvKey("foo!", { label: "rest_key", errorMessage: message })).toThrow(message)
        expect(() => normalizeEnvKey("foo/bar", { label: "rest_key", errorMessage: message })).toThrow(message)
    })

    test("uses provided errorMessage verbatim even when characters are otherwise valid", () => {
        const message = "ssh_key must contain only letters, digits, underscore, or hyphen"
        expect(() => normalizeEnvKey("ok", { allowHyphen: true, errorMessage: message })).not.toThrow()
        expect(() => normalizeEnvKey("bad char", { allowHyphen: true, errorMessage: message })).toThrow(message)
    })
})

describe("buildEnvVarName", () => {
    test("joins prefix, normalized key, and field with underscores", () => {
        expect(buildEnvVarName("AUTOCODE_DB", "REPORTING", "CONNECTION")).toBe("AUTOCODE_DB_REPORTING_CONNECTION")
        expect(buildEnvVarName("AUTOCODE_DB", "REPORTING", "USERNAME")).toBe("AUTOCODE_DB_REPORTING_USERNAME")
        expect(buildEnvVarName("AUTOCODE_DB", "REPORTING", "PASSWORD")).toBe("AUTOCODE_DB_REPORTING_PASSWORD")
    })

    test("supports arbitrary prefix and field combinations", () => {
        expect(buildEnvVarName("AUTOCODE_SSH", "DEV", "HOST")).toBe("AUTOCODE_SSH_DEV_HOST")
        expect(buildEnvVarName("AUTOCODE_REST", "API", "AUTHORIZATION")).toBe("AUTOCODE_REST_API_AUTHORIZATION")
    })
})
