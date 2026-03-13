import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, mkdir, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { generatePlanName, isConcurrentGroup, createBuildTools } from "./build"

/**
 * Unit tests for exported pure functions and the auto-detection behavior of
 * autocode_build_concurrent_task.
 */

// ─── generatePlanName ────────────────────────────────────────────────────────

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

// ─── isConcurrentGroup ────────────────────────────────────────────────────────

describe("isConcurrentGroup", () => {
    test("returns true for valid concurrent group directory names", () => {
        expect(isConcurrentGroup("00-concurrent_group")).toBe(true)
        expect(isConcurrentGroup("01-concurrent_group")).toBe(true)
        expect(isConcurrentGroup("10-concurrent_group")).toBe(true)
        expect(isConcurrentGroup("99-concurrent_group")).toBe(true)
    })

    test("returns false for sequential task directory names", () => {
        expect(isConcurrentGroup("00-my_task")).toBe(false)
        expect(isConcurrentGroup("01-login_endpoint")).toBe(false)
        expect(isConcurrentGroup("02-setup_database")).toBe(false)
    })

    test("returns false for malformed names", () => {
        expect(isConcurrentGroup("concurrent_group")).toBe(false)         // no numeric prefix
        expect(isConcurrentGroup("0-concurrent_group")).toBe(false)       // single-digit prefix
        expect(isConcurrentGroup("001-concurrent_group")).toBe(false)     // three-digit prefix
        expect(isConcurrentGroup("01-concurrent_group_extra")).toBe(false) // trailing text
        expect(isConcurrentGroup("")).toBe(false)
    })
})

// ─── autocode_build_concurrent_task auto-detection ───────────────────────────

/**
 * Integration tests for the auto-detection logic inside autocode_build_concurrent_task.
 *
 * We use a real temp directory so the filesystem behaviour is exact.
 * The tool's `execute` function is called directly via createBuildTools.
 */
describe("autocode_build_concurrent_task — auto-detection", () => {
    // Minimal mock client — these tests never call client methods
    const mockClient = {} as any

    let tmpDir: string
    let planName: string
    let awaitDir: string

    beforeEach(async () => {
        tmpDir = await mkdtemp(path.join(tmpdir(), "autocode-test-"))
        planName = "test_plan"
        awaitDir = path.join(tmpDir, ".autocode", "build", planName)
        await mkdir(awaitDir, { recursive: true })
    })

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true })
    })

    function makeContext() {
        return { worktree: tmpDir } as any
    }

    function tools() {
        return createBuildTools(mockClient)
    }

    test("creates a new concurrent group when awaiting/ is empty", async () => {
        const { autocode_build_concurrent_task } = tools()

        const result = await autocode_build_concurrent_task.execute(
            { plan_name: planName, task_name: "task_a", agent: "code", execute: "do task a" },
            makeContext(),
        )

        expect(result).toContain("✅")
        expect(result).toContain("00-concurrent_group/task_a")
    })

    test("creates a new concurrent group when last entry is a sequential task", async () => {
        // Pre-create a sequential task directory
        await mkdir(path.join(awaitDir, "00-sequential_task"), { recursive: true })

        const { autocode_build_concurrent_task } = tools()

        const result = await autocode_build_concurrent_task.execute(
            { plan_name: planName, task_name: "task_b", agent: "code", execute: "do task b" },
            makeContext(),
        )

        expect(result).toContain("✅")
        // Should create group at order 01 (after the sequential at 00)
        expect(result).toContain("01-concurrent_group/task_b")
    })

    test("adds to existing concurrent group when last entry is already a concurrent group", async () => {
        // Pre-create a concurrent group (as if a previous task already created it)
        const groupDir = path.join(awaitDir, "00-concurrent_group")
        await mkdir(path.join(groupDir, "task_a"), { recursive: true })

        const { autocode_build_concurrent_task } = tools()

        const result = await autocode_build_concurrent_task.execute(
            { plan_name: planName, task_name: "task_b", agent: "code", execute: "do task b" },
            makeContext(),
        )

        expect(result).toContain("✅")
        // Must re-use group 00, NOT create group 01
        expect(result).toContain("00-concurrent_group/task_b")
        expect(result).not.toContain("01-concurrent_group")
    })

    test("two consecutive concurrent task calls share the same group", async () => {
        const { autocode_build_concurrent_task } = tools()
        const ctx = makeContext()

        const r1 = await autocode_build_concurrent_task.execute(
            { plan_name: planName, task_name: "task_a", agent: "code", execute: "do a" },
            ctx,
        )
        const r2 = await autocode_build_concurrent_task.execute(
            { plan_name: planName, task_name: "task_b", agent: "code", execute: "do b" },
            ctx,
        )

        expect(r1).toContain("00-concurrent_group/task_a")
        expect(r2).toContain("00-concurrent_group/task_b")
    })

    test("sequential task after concurrent group creates new order slot", async () => {
        // First add a concurrent group with one task
        const groupDir = path.join(awaitDir, "00-concurrent_group")
        await mkdir(path.join(groupDir, "task_a"), { recursive: true })

        const { autocode_build_next_task } = tools()

        const result = await autocode_build_next_task.execute(
            { plan_name: planName, task_name: "next_sequential", agent: "code", execute: "do it" },
            makeContext(),
        )

        const parsed = JSON.parse(result)
        expect(parsed.result.success).toBe(true)

        // Verify the directory was created at order 01
        const { readdir } = await import("fs/promises")
        const entries = await readdir(awaitDir)
        expect(entries).toContain("01-next_sequential")
    })

    test("writes {agent}.prompt.md with execute content", async () => {
        const { autocode_build_concurrent_task } = tools()

        await autocode_build_concurrent_task.execute(
            {
                plan_name: planName,
                task_name: "task_a",
                agent: "code",
                execute: "build instructions",
            },
            makeContext(),
        )

        const { readFile } = await import("fs/promises")
        const buildContent = await readFile(
            path.join(awaitDir, "00-concurrent_group", "task_a", "code.prompt.md"),
            "utf-8",
        )

        expect(buildContent).toBe("build instructions")
    })

    test("auto-generates test.prompt.md when test param is omitted and agent is not 'test'", async () => {
        const { autocode_build_concurrent_task } = tools()

        await autocode_build_concurrent_task.execute(
            {
                plan_name: planName,
                task_name: "task_a",
                agent: "code",
                execute: "build instructions",
            },
            makeContext(),
        )

        const { readFile } = await import("fs/promises")
        const testContent = await readFile(
            path.join(awaitDir, "00-concurrent_group", "task_a", "test.prompt.md"),
            "utf-8",
        )

        expect(testContent).toContain("build instructions")
        expect(testContent).toContain("Verify that these instructions were correctly followed.")
    })

    test("test.prompt.md contains provided test content when test param is given", async () => {
        const { autocode_build_concurrent_task } = tools()

        await autocode_build_concurrent_task.execute(
            {
                plan_name: planName,
                task_name: "task_a",
                agent: "code",
                execute: "build instructions",
                test: "check that the build output exists",
            },
            makeContext(),
        )

        const { readFile } = await import("fs/promises")
        const testContent = await readFile(
            path.join(awaitDir, "00-concurrent_group", "task_a", "test.prompt.md"),
            "utf-8",
        )

        expect(testContent).toBe("check that the build output exists")
    })

    test("does not create test.prompt.md when agent is 'test'", async () => {
        const { autocode_build_concurrent_task } = tools()

        await autocode_build_concurrent_task.execute(
            {
                plan_name: planName,
                task_name: "task_a",
                agent: "test",
                execute: "verify the output",
            },
            makeContext(),
        )

        const { readFile } = await import("fs/promises")
        const testPromptPath = path.join(awaitDir, "00-concurrent_group", "task_a", "test.prompt.md")
        const content = await readFile(testPromptPath, "utf-8")
        // test.prompt.md exists as the agent's execution prompt (not a verification file)
        expect(content).toBe("verify the output")
        // It must NOT contain the auto-generated verification template
        expect(content).not.toContain("Verify that these instructions were correctly followed.")
    })


})
