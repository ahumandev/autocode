import { tool, ToolDefinition, PluginInput } from "@opencode-ai/plugin"
import { mkdir, writeFile, readdir, stat } from "fs/promises"
import path from "path"

type Client = PluginInput["client"]

/**
 * Tools for the Build agent to scaffold plan directories and task prompt files
 * inside `.autocode/build/<plan_name>/`.
 *
 * Directory layout:
 *
 *   .autocode/build/<plan_name>/
 *     plan.md                          ← full approved plan text
 *     .review.md                       ← human review instructions
 *     accepted/
 *       <order>-<task_name>/           ← sequential task
 *         build.prompt.md
 *         test.prompt.md  (optional)
 *       <slot>-(parallel)/             ← parallel slot directory
 *         <task_name>/                 ← one sub-dir per parallel task
 *           build.prompt.md
 *           test.prompt.md  (optional)
 */
/**
 * Pure function that sanitizes a raw name proposal into a valid plan name.
 * Exported so it can be unit-tested independently of the tool infrastructure.
 *
 * Rules applied in order:
 * 1. Trim whitespace. If the input is empty after trimming → return null (invalid).
 * 2. Lowercase all letters.
 * 3. Replace every non-alphanumeric character with `_`.
 * 4. Collapse consecutive underscores to a single `_` (repeat until stable).
 * 5. Strip leading / trailing underscores.
 * 6. If the result is now empty (input contained only invalid characters) → return null (invalid).
 * 7. Split on `_` into words (filtering empty tokens).
 *    - Keep first 7 words as-is.
 *    - Words 8, 9, … are abbreviated to their first character each, then
 *      concatenated into a single 8th token.
 * 8. Rejoin with `_`.
 *
 * Returns the sanitized name string, or `null` when the input yields no valid characters.
 */
export function generatePlanName(raw: string): string | null {
    const trimmed = raw.trim()

    // Rule 1 — empty input
    if (trimmed === "") {
        return null
    }

    // Rule 2 — lowercase
    let name = trimmed.toLowerCase()

    // Rule 3 — non-alphanumeric → underscore
    name = name.replace(/[^a-z0-9]/g, "_")

    // Rule 4 — collapse consecutive underscores
    while (name.includes("__")) {
        name = name.replace(/__+/g, "_")
    }

    // Rule 5 — strip leading / trailing underscores
    name = name.replace(/^_+|_+$/g, "")

    // Rule 6 — nothing left after stripping
    if (name === "") {
        return null
    }

    // Rule 7 — word limit with abbreviation
    const words = name.split("_").filter(Boolean)
    if (words.length > 7) {
        const kept = words.slice(0, 7)
        const abbrev = words.slice(7).map(w => w[0]).join("")
        kept.push(abbrev)
        name = kept.join("_")
    } else {
        name = words.join("_")
    }

    return name
}

export function createBuildTools(client: Client): Record<string, ToolDefinition> {

    // ─── internal helpers ───────────────────────────────────────────────────

    /**
     * Read the highest numeric prefix that exists inside a directory.
     * Returns -1 when the directory is empty or has no numbered entries.
     */
    async function maxOrder(dir: string): Promise<number> {
        const entries = await readdir(dir).catch(() => [] as string[])
        let max = -1
        for (const e of entries) {
            const m = e.match(/^(\d+)-/)
            if (m) {
                const n = parseInt(m[1], 10)
                if (n > max) max = n
            }
        }
        return max
    }

    /**
     * Return the last entry (by name) inside a directory, or null.
     */
    async function lastEntry(dir: string): Promise<string | null> {
        const entries = await readdir(dir).catch(() => [] as string[])
        if (entries.length === 0) return null
        // Sort numerically on the leading number, then alphabetically
        entries.sort((a, b) => {
            const na = parseInt(a.match(/^(\d+)/)?.[1] ?? "0", 10)
            const nb = parseInt(b.match(/^(\d+)/)?.[1] ?? "0", 10)
            if (na !== nb) return na - nb
            return a.localeCompare(b)
        })
        return entries[entries.length - 1]
    }

    // ─── tool definitions ────────────────────────────────────────────────────

    /**
     * Generates a sanitized, de-duplicated plan name from a raw proposal,
     * then initializes the plan directory and writes `plan.md` in one step.
     *
     * Sanitization rules (applied in order):
     * 1. Trim whitespace. Empty input → { valid: false }.
     * 2. Lowercase all letters.
     * 3. Replace any non-alphanumeric character with `_`.
     * 4. Collapse consecutive underscores to a single `_` (repeat until stable).
     * 5. Strip leading/trailing underscores.
     * 6. Empty result after stripping (only invalid chars given) → { valid: false }.
     * 7. Split on `_` into words. Keep first 7. Words 8+ are abbreviated to
     *    their first letter and joined as a single 8th token.
     * 8. If the resulting directory already exists, append `_<timestamp>`.
     *
     * On success: creates .autocode/build/<name>/ with plan.md and accepted/,
     * then returns { valid: true, name }.
     * On invalid name: returns { valid: false } without touching the filesystem.
     */
    const autocode_build_plan: ToolDefinition = tool({
        description:
            "Generate a sanitized plan name from a raw proposal, then initialize the plan directory. " +
            "Provide no more than 7 words — if more than 7 words are given, the first 7 are kept " +
            "and all remaining words (8th, 9th, …) are abbreviated to their first letters and " +
            "combined into a single 8th token. " +
            "Returns { valid: true, name } on success — the plan directory is created and plan.md is written; " +
            "always use the returned name in all subsequent tool calls. " +
            "Returns { valid: false } when the input yields no valid characters after sanitization — call again with a different name.",
        args: {
            name: tool.schema
                .string()
                .describe("Raw plan name proposal — provide at most 7 words (space- or underscore-separated)"),
            plan_md_content: tool.schema
                .string()
                .describe("The full approved plan text to write into plan.md"),
        },
        async execute(args, context) {
            const sanitized = generatePlanName(args.name)

            if (sanitized === null) {
                return JSON.stringify({ valid: false })
            }

            // De-duplicate: append timestamp if a directory already exists
            const buildDir = path.join(context.worktree, ".autocode", "build")
            const candidatePath = path.join(buildDir, sanitized)
            const exists = await stat(candidatePath).catch(() => null)

            const finalName = exists ? `${sanitized}_${Date.now()}` : sanitized

            const planDir = path.join(buildDir, finalName)
            const acceptedDir = path.join(planDir, "accepted")

            try {
                await mkdir(acceptedDir, { recursive: true })
                await writeFile(path.join(planDir, "plan.md"), args.plan_md_content, "utf-8")
                return JSON.stringify({ valid: true, name: finalName })
            } catch (err: any) {
                return `❌ Failed to initialize plan '${finalName}': ${err.message}`
            }
        },
    })

    /**
     * Creates the next sequential task directory and its prompt files.
     *
     * The directory name is `<N>-<task_name>` where N = (current max order + 1).
     * If the last created entry was a parallel slot, this new sequential task
     * gets the next order number after that slot.
     */
    const autocode_build_create_next_task: ToolDefinition = tool({
        description:
            "Create the next sequential task inside the plan's accepted/ directory. " +
            "The numeric prefix is assigned automatically. " +
            "Call this for tasks that must run after all previously created tasks.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("Plan name returned by autocode_build_plan"),
            task_name: tool.schema
                .string()
                .describe("Lowercase underscore task name (e.g. install_auth_deps)"),
            task_prompt: tool.schema
                .string()
                .describe("Full build instructions for the execute agent"),
            test_prompt: tool.schema
                .string()
                .optional()
                .describe("Test verification instructions for the test agent (optional)"),
        },
        async execute(args, context) {
            const acceptedDir = path.join(
                context.worktree,
                ".autocode",
                "build",
                args.plan_name,
                "accepted",
            )

            try {
                const order = (await maxOrder(acceptedDir)) + 1
                const dirName = `${order}-${args.task_name}`
                const taskDir = path.join(acceptedDir, dirName)

                await mkdir(taskDir, { recursive: true })
                await writeFile(path.join(taskDir, "build.prompt.md"), args.task_prompt, "utf-8")
                if (args.test_prompt) {
                    await writeFile(path.join(taskDir, "test.prompt.md"), args.test_prompt, "utf-8")
                }

                return `✅ Sequential task '${dirName}' created (order ${order})`
            } catch (err: any) {
                return `❌ Failed to create sequential task '${args.task_name}': ${err.message}`
            }
        },
    })

    /**
     * Adds a task to the current parallel slot.
     *
     * - If the last entry in accepted/ is a `-(parallel)` directory, the new
     *   task is placed inside it as a sub-directory (same slot).
     * - Otherwise a new parallel slot is opened with the next order number.
     */
    const autocode_build_add_parallel_task: ToolDefinition = tool({
        description:
            "Add a task to the current parallel slot inside the plan's accepted/ directory. " +
            "Consecutive calls group tasks into the same parallel slot. " +
            "Call autocode_build_create_next_task first if you need to open a new sequential step.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("Plan name returned by autocode_build_plan"),
            task_name: tool.schema
                .string()
                .describe("Lowercase underscore task name (e.g. login_endpoint)"),
            task_prompt: tool.schema
                .string()
                .describe("Full build instructions for the execute agent"),
            test_prompt: tool.schema
                .string()
                .optional()
                .describe("Test verification instructions for the test agent (optional)"),
        },
        async execute(args, context) {
            const acceptedDir = path.join(
                context.worktree,
                ".autocode",
                "build",
                args.plan_name,
                "accepted",
            )

            try {
                // Determine whether the last entry is already a parallel slot
                const last = await lastEntry(acceptedDir)
                let slotDir: string

                if (last && last.endsWith("-(parallel)")) {
                    // Re-use existing parallel slot
                    slotDir = path.join(acceptedDir, last)
                } else {
                    // Open a new parallel slot
                    const order = (await maxOrder(acceptedDir)) + 1
                    const slotName = `${order}-(parallel)`
                    slotDir = path.join(acceptedDir, slotName)
                    await mkdir(slotDir, { recursive: true })
                }

                const taskDir = path.join(slotDir, args.task_name)
                await mkdir(taskDir, { recursive: true })
                await writeFile(path.join(taskDir, "build.prompt.md"), args.task_prompt, "utf-8")
                if (args.test_prompt) {
                    await writeFile(path.join(taskDir, "test.prompt.md"), args.test_prompt, "utf-8")
                }

                const slotName = path.basename(slotDir)
                return `✅ Parallel task '${slotName}/${args.task_name}' created`
            } catch (err: any) {
                return `❌ Failed to create parallel task '${args.task_name}': ${err.message}`
            }
        },
    })

    /**
     * Writes `.review.md` to finalize the plan for human review.
     */
    const autocode_build_finalize_plan: ToolDefinition = tool({
        description:
            "Finalize the plan by writing .review.md with human review instructions. " +
            "Call this after all tasks have been created.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("Plan name returned by autocode_build_plan"),
            review_md_content: tool.schema
                .string()
                .describe("Human review instructions to write into .review.md"),
        },
        async execute(args, context) {
            const planDir = path.join(
                context.worktree,
                ".autocode",
                "build",
                args.plan_name,
            )

            try {
                await writeFile(
                    path.join(planDir, ".review.md"),
                    args.review_md_content,
                    "utf-8",
                )
                return `✅ Plan '${args.plan_name}' finalized — .review.md written`
            } catch (err: any) {
                return `❌ Failed to finalize plan '${args.plan_name}': ${err.message}`
            }
        },
    })

    return {
        autocode_build_plan,
        autocode_build_create_next_task,
        autocode_build_add_parallel_task,
        autocode_build_finalize_plan,
    }
}
