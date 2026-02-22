import { describe, test, expect } from "bun:test"
import { generatePlanName } from "./build"

/**
 * Unit tests for the `generatePlanName` pure function.
 *
 * This function is used internally by the `autocode_build_plan` tool, which
 * combines name sanitization + plan directory initialization into a single call:
 * - If `generatePlanName` returns null → tool returns { valid: false } (no filesystem changes)
 * - If `generatePlanName` returns a string → tool creates the plan directory and
 *   returns { valid: true, name: finalName }
 *
 * The tool also de-duplicates by appending `_<timestamp>` when the directory
 * already exists, but that behavior is not tested here (requires filesystem).
 */
describe("generatePlanName", () => {

    // ── empty / whitespace-only inputs ──────────────────────────────────────

    test("empty string returns null", () => {
        expect(generatePlanName("")).toBeNull()
    })

    test("whitespace-only string returns null", () => {
        expect(generatePlanName("   ")).toBeNull()
        expect(generatePlanName("\t\n")).toBeNull()
    })

    test("string with only non-alphanumeric characters returns null", () => {
        expect(generatePlanName("!!!")).toBeNull()
        expect(generatePlanName("---")).toBeNull()
        expect(generatePlanName("@#$%")).toBeNull()
        expect(generatePlanName("___")).toBeNull()
    })

    // ── uppercase → lowercase ───────────────────────────────────────────────

    test("uppercases letters are lowercased", () => {
        expect(generatePlanName("MyPlan")).toBe("myplan")
    })

    test("all-caps input is fully lowercased", () => {
        expect(generatePlanName("ADD USER AUTH")).toBe("add_user_auth")
    })

    test("mixed-case with spaces is lowercased and underscored", () => {
        expect(generatePlanName("Add User Auth")).toBe("add_user_auth")
    })

    // ── non-alphanumeric → underscore ────────────────────────────────────────

    test("spaces are replaced with underscores", () => {
        expect(generatePlanName("add user auth")).toBe("add_user_auth")
    })

    test("hyphens are replaced with underscores", () => {
        expect(generatePlanName("add-user-auth")).toBe("add_user_auth")
    })

    test("dots are replaced with underscores", () => {
        expect(generatePlanName("add.user.auth")).toBe("add_user_auth")
    })

    test("mixed special chars are all replaced with underscores", () => {
        expect(generatePlanName("add!user@auth#plan")).toBe("add_user_auth_plan")
    })

    // ── double underscores → single underscore ───────────────────────────────

    test("double underscores are collapsed to single", () => {
        expect(generatePlanName("add__user")).toBe("add_user")
    })

    test("triple underscores are collapsed to single", () => {
        expect(generatePlanName("add___user")).toBe("add_user")
    })

    test("multiple separate double underscores are all collapsed", () => {
        expect(generatePlanName("add__user__auth")).toBe("add_user_auth")
    })

    test("special chars producing consecutive underscores are collapsed", () => {
        // "add  user" → "add__user" → "add_user"
        expect(generatePlanName("add  user")).toBe("add_user")
        // "add!@user" → "add__user" → "add_user"
        expect(generatePlanName("add!@user")).toBe("add_user")
    })

    // ── strip leading / trailing underscores ─────────────────────────────────

    test("leading underscore is stripped", () => {
        expect(generatePlanName("_my_plan")).toBe("my_plan")
    })

    test("trailing underscore is stripped", () => {
        expect(generatePlanName("my_plan_")).toBe("my_plan")
    })

    test("leading and trailing underscores are stripped", () => {
        expect(generatePlanName("_my_plan_")).toBe("my_plan")
    })

    test("leading special chars that become underscores are stripped", () => {
        // "!my_plan" → "_my_plan" → "my_plan"
        expect(generatePlanName("!my_plan")).toBe("my_plan")
    })

    test("trailing special chars that become underscores are stripped", () => {
        // "my_plan!" → "my_plan_" → "my_plan"
        expect(generatePlanName("my_plan!")).toBe("my_plan")
    })

    // ── 7-word limit ─────────────────────────────────────────────────────────

    test("exactly 7 words are kept unchanged", () => {
        expect(generatePlanName("one two three four five six seven")).toBe(
            "one_two_three_four_five_six_seven",
        )
    })

    test("8 words: first 7 kept, 8th abbreviated to its first letter", () => {
        expect(generatePlanName("one two three four five six seven eight")).toBe(
            "one_two_three_four_five_six_seven_e",
        )
    })

    test("9 words: first 7 kept, words 8 and 9 abbreviated into one token", () => {
        expect(generatePlanName("one two three four five six seven eight nine")).toBe(
            "one_two_three_four_five_six_seven_en",
        )
    })

    test("10 words: abbreviation combines last 3 words", () => {
        expect(generatePlanName("one two three four five six seven eight nine ten")).toBe(
            "one_two_three_four_five_six_seven_ent",
        )
    })

    test("word abbreviation uses first character of each extra word", () => {
        // words 8-10: "alpha", "beta", "gamma" → abbrev = "abg"
        expect(
            generatePlanName("one two three four five six seven alpha beta gamma"),
        ).toBe("one_two_three_four_five_six_seven_abg")
    })

    // ── compound / integration cases ─────────────────────────────────────────

    test("uppercase + spaces + 8 words", () => {
        // "Add User Auth Plan With JWT Token Support"
        // → lowercased: "add user auth plan with jwt token support"
        // → underscored: "add_user_auth_plan_with_jwt_token_support"
        // → 8 words: first 7 + abbrev("support") = "s"
        expect(generatePlanName("Add User Auth Plan With JWT Token Support")).toBe(
            "add_user_auth_plan_with_jwt_token_s",
        )
    })

    test("all rules combined: mixed case, specials, leading/trailing, 9 words", () => {
        // "  !!One-Two THREE__four FIVE six Seven eight NINE!!  "
        // after trim: "!!One-Two THREE__four FIVE six Seven eight NINE!!"
        // lowercase: "!!one-two three__four five six seven eight nine!!"
        // non-alnum→_: "__one_two_three__four_five_six_seven_eight_nine__"
        // collapse __: "_one_two_three_four_five_six_seven_eight_nine_"
        // strip edges: "one_two_three_four_five_six_seven_eight_nine"
        // 9 words: keep 7, abbrev "eight"+"nine" = "en"
        expect(
            generatePlanName("  !!One-Two THREE__four FIVE six Seven eight NINE!!  "),
        ).toBe("one_two_three_four_five_six_seven_en")
    })

    test("single word input is returned as-is (lowercased)", () => {
        expect(generatePlanName("MyPlan")).toBe("myplan")
        expect(generatePlanName("plan")).toBe("plan")
    })

    test("digits are preserved", () => {
        expect(generatePlanName("plan v2 upgrade")).toBe("plan_v2_upgrade")
    })

    test("digits-only input is valid", () => {
        expect(generatePlanName("123")).toBe("123")
    })

    test("underscore-separated input is treated as words", () => {
        expect(generatePlanName("one_two_three")).toBe("one_two_three")
    })

    test("mix of underscores and spaces as word separators", () => {
        expect(generatePlanName("one_two three")).toBe("one_two_three")
    })
})
