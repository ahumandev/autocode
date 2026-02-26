import { tool, ToolDefinition, PluginInput } from "@opencode-ai/plugin"
import { mkdir, writeFile, readdir, stat, rename } from "fs/promises"
import path from "path"
import {
    validateNonEmpty,
    validateHasAlphanumeric,
    retryResponse,
    abortResponse,
    successResponse,
} from "@/utils/validation"

type Client = PluginInput["client"]

// ─── module-level helpers (exported for unit testing) ────────────────────────

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

    // Rule 1 — lowercase
    let name = trimmed.toLowerCase()

    // Rule 2 — non-alphanumeric → underscore
    name = name.replace(/[^a-z0-9]/g, "_")

    // Rule 3 — collapse consecutive underscores
    while (name.includes("__")) {
        name = name.replace(/__+/g, "_")
    }

    // Rule 4 — strip leading / trailing underscores
    name = name.replace(/^_+|_+$/g, "")

    // Rule 5 — nothing left after stripping
    if (name === "") {
        return null
    }

    // Rule 6 — word limit with abbreviation
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

/**
 * Returns true when a directory name represents a concurrent task group.
 * Convention: concurrent group dirs are named `<NN>-concurrent_group`
 * where NN is a zero-padded two-digit order prefix.
 * Exported for unit testing.
 */
export function isConcurrentGroup(name: string): boolean {
    return /^\d{2}-concurrent_group$/.test(name)
}

// ─── module-level async helpers ──────────────────────────────────────────────

/**
 * Read the highest numeric prefix that exists inside a directory.
 * Returns -1 when the directory is empty or has no numbered entries.
 */
async function lastIndex(dir: string): Promise<number> {
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

/**
 * Creates a new concurrent task group directory inside accepted/.
 * Directory name: `<NN>-concurrent_group` (NN = zero-padded lastIndex+1).
 * Returns the full path to the new group directory.
 */
async function createConcurrentGroupDir(acceptedDir: string): Promise<string> {
    const order = (await lastIndex(acceptedDir)) + 1
    const padded = String(order).padStart(2, "0")
    const slotName = `${padded}-concurrent_group`
    const slotDir = path.join(acceptedDir, slotName)
    await mkdir(slotDir, { recursive: true })
    return slotDir
}

// ─── tool factory ─────────────────────────────────────────────────────────────

/**
 * Tools for the Build agent to scaffold plan directories and task prompt files
 * inside `.autocode/build/<plan_name>/`.
 *
 * Directory layout:
 *
 *   .autocode/build/<plan_name>/
 *     plan.md                          ← full approved plan text
 *     accepted/
 *       <order>-<task_name>/           ← sequential task
 *         instructions.md
 *       <order>-concurrent_group/      ← concurrent task group directory
 *         <task_name>/                 ← one sub-dir per concurrent task
 *           build.prompt.md
 */
export function createBuildTools(client: Client): Record<string, ToolDefinition> {

    // ─── idempotency guard for autocode_build_fail ───────────────────────────
    // Tracks plan names that have already been moved to .autocode/failed/.
    // Subsequent calls for the same plan_name are no-ops.
    const failedPlans = new Set<string>()

    // ─── shared fail helper ───────────────────────────────────────────────────

    /**
     * Moves `.autocode/build/<plan_name>` to `.autocode/failed/<plan_name>` and
     * writes `failure.md` with the given reason. Idempotent: if the plan has
     * already been failed in this session the function returns immediately.
     *
     * @param worktree  Absolute path to the repository root.
     * @param planName  The sanitized plan name.
     * @param reason    Human-readable failure reason written to `failure.md`.
     */
    async function failPlan(worktree: string, planName: string, reason: string): Promise<void> {
        if (failedPlans.has(planName)) {
            return
        }

        // Register immediately so concurrent callers don't race.
        failedPlans.add(planName)

        const buildDir = path.join(worktree, ".autocode", "build", planName)
        const failedDir = path.join(worktree, ".autocode", "failed", planName)

        try {
            // Ensure the failed/ parent directory exists.
            await mkdir(path.join(worktree, ".autocode", "failed"), { recursive: true })

            // Move the plan directory.
            await rename(buildDir, failedDir)

            // Write the failure reason.
            await writeFile(path.join(failedDir, "failure.md"), reason, "utf-8")
        } catch {
            // Best-effort — if the move fails we still want the caller to abort.
        }
    }

    // ─── tool definitions ────────────────────────────────────────────────────

    /**
     * Generates a sanitized, de-duplicated plan name from a raw proposal,
     * then initializes the plan directory and writes `plan.md` in one step.
     *
     * Sanitization rules (applied in order):
     * 1. Trim whitespace. Empty input → error.
     * 2. Lowercase all letters.
     * 3. Replace any non-alphanumeric character with `_`.
     * 4. Collapse consecutive underscores to a single `_` (repeat until stable).
     * 5. Strip leading/trailing underscores.
     * 6. Empty result after stripping (only invalid chars given) → error.
     * 7. Split on `_` into words. Keep first 7. Words 8+ are abbreviated to
     *    their first letter and joined as a single 8th token.
     * 8. If the resulting directory already exists, append `_<timestamp>`.
     *
     * On success: creates .autocode/build/<name>/ with plan.md and accepted/,
     * then returns { plan_name }.
     * On invalid name: returns { error } without touching the filesystem.
     */
    const autocode_build_plan: ToolDefinition = tool({
        description:
            "Generate a sanitized plan name from a raw proposal, then initialize the plan directory. " +
            "Provide no more than 7 words — if more than 7 words are given, the first 7 are kept " +
            "and all remaining words (8th, 9th, …) are abbreviated to their first letters and " +
            "combined into a single 8th token. " +
            "Returns { plan_name } on success — the plan is persisted; " +
            "always use the returned plan_name in all subsequent tool calls. " +
            "Returns { error } when the input is invalid or an internal failure occurs.",
        args: {
            name: tool.schema
                .string()
                .describe("Raw plan name proposal — provide at most 7 words (underscore-separated) that summarize the purpose of the plan"),
            plan_content: tool.schema
                .string()
                .describe("The full approved plan text to write into plan.md"),
        },
        async execute(args, context) {
            const toolName = "autocode_build_plan"
            const sid = context.sessionID

            // ── input validation ──────────────────────────────────────────────
            const nameEmptyErr = validateNonEmpty(args.name, sid, toolName, "name")
            if (nameEmptyErr) return nameEmptyErr

            const nameAlphaErr = validateHasAlphanumeric(args.name, sid, toolName, "name")
            if (nameAlphaErr) return nameAlphaErr

            const sanitized = generatePlanName(args.name)
            if (sanitized === null) {
                return retryResponse(
                    sid,
                    toolName,
                    "name",
                    "contain at least one alphanumeric character after sanitization (e.g. 'my_plan')",
                )
            }

            const contentErr = validateNonEmpty(args.plan_content, sid, toolName, "plan_content")
            if (contentErr) return contentErr

            // ── filesystem work ───────────────────────────────────────────────
            // De-duplicate: append timestamp if a directory already exists
            const buildDir = path.join(context.worktree, ".autocode", "build")
            const candidatePath = path.join(buildDir, sanitized)
            const exists = await stat(candidatePath).catch(() => null)

            const finalName = exists ? `${sanitized}_${Date.now()}` : sanitized
            const planDir = path.join(buildDir, finalName)
            const acceptedDir = path.join(planDir, "accepted")

            try {
                await mkdir(acceptedDir, { recursive: true })
                await writeFile(path.join(planDir, "plan.md"), args.plan_content, "utf-8")
                return successResponse(sid, toolName, { plan_name: finalName })
            } catch (err: any) {
                await failPlan(context.worktree, finalName, `${toolName} failed to initialize plan directory: ${err.message}`)
                return abortResponse(toolName, `failed to create plan directory for '${finalName}': ${err.message}`)
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
    const autocode_build_next_task: ToolDefinition = tool({
        description: "Use this tool to create the first task in the plan or to create tasks that depends on the successful execution of the previous tasks.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("`plan_name` returned by autocode_build_plan"),
            task_name: tool.schema
                .string()
                .describe("Describe the task's purpose in < 10 words"),
            instructions: tool.schema
                .string()
                .describe("Task background, instructions, rules and testing steps to ensure the task's instructions was correctly executed."),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_build_next_task"

            // ── input validation ──────────────────────────────────────────────
            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const taskNameErr = validateNonEmpty(args.task_name, sid, toolName, "task_name")
            if (taskNameErr) return taskNameErr

            const instructionsErr = validateNonEmpty(args.instructions, sid, toolName, "instructions")
            if (instructionsErr) return instructionsErr

            // ── check the plan directory exists (input problem if it does not) ──
            const planDirStat = await stat(path.join(context.worktree, ".autocode", "build", args.plan_name)).catch(() => null)
            if (!planDirStat) {
                return retryResponse(
                    sid,
                    toolName,
                    "plan_name",
                    `match an existing plan directory — '${args.plan_name}' does not exist; use the exact plan_name returned by autocode_build_plan`,
                )
            }

            const acceptedDir = path.join(
                context.worktree,
                ".autocode",
                "build",
                args.plan_name,
                "accepted",
            )

            // ── filesystem work ───────────────────────────────────────────────
            try {
                const order = (await lastIndex(acceptedDir)) + 1
                const padded = String(order).padStart(2, "0")
                const dirName = `${padded}-${args.task_name}`
                const taskDir = path.join(acceptedDir, dirName)

                await mkdir(taskDir, { recursive: true })
                await writeFile(path.join(taskDir, "instructions.md"), args.instructions, "utf-8")

                return successResponse(sid, toolName)
            } catch (err: any) {
                await failPlan(context.worktree, args.plan_name, `${toolName} failed to create task '${args.task_name}': ${err.message}`)
                return abortResponse(toolName, `failed to create task '${args.task_name}' for plan '${args.plan_name}': ${err.message}`)
            }
        }
    })

    /**
     * Adds a task to a concurrent task group.
     *
     * Auto-detection logic:
     * - If the last entry in accepted/ is already a concurrent group → add this task to it (parallel).
     * - If the last entry is a sequential task (or accepted/ is empty) → create a new concurrent group
     *   and place this task inside it.
     *
     * This means the agent never needs to manually call a separate "create group" tool.
     */
    const autocode_build_concurrent_task: ToolDefinition = tool({
        description:
            "Add a task to a concurrent task group so it runs in parallel with other tasks in the same group. " +
            "The tool automatically detects whether a concurrent group already exists: " +
            "if the last task was sequential (or no tasks exist yet), a new concurrent group is created automatically; " +
            "if the last task was already part of a concurrent group, this task is added to that same group.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("Plan name returned by autocode_build_plan"),
            task_name: tool.schema
                .string()
                .describe("Lowercase underscore task name (e.g. login_endpoint)"),
            instructions: tool.schema
                .string()
                .describe("Task background, instructions, rules and testing steps to ensure the task's instructions was correctly executed."),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_build_concurrent_task"

            // ── input validation ──────────────────────────────────────────────
            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const taskNameErr = validateNonEmpty(args.task_name, sid, toolName, "task_name")
            if (taskNameErr) return taskNameErr

            const taskPromptErr = validateNonEmpty(args.instructions, sid, toolName, "instructions")
            if (taskPromptErr) return taskPromptErr

            // ── check the plan directory exists (input problem if it does not) ──
            const planDirStat = await stat(path.join(context.worktree, ".autocode", "build", args.plan_name)).catch(() => null)
            if (!planDirStat) {
                return retryResponse(
                    sid,
                    toolName,
                    "plan_name",
                    `match an existing plan directory — '${args.plan_name}' does not exist; use the exact plan_name returned by autocode_build_plan`,
                )
            }

            const acceptedDir = path.join(
                context.worktree,
                ".autocode",
                "build",
                args.plan_name,
                "accepted",
            )

            // ── filesystem work ───────────────────────────────────────────────
            try {
                // Determine whether the last entry is already a concurrent group
                const last = await lastEntry(acceptedDir)
                let slotDir: string

                if (last && isConcurrentGroup(last)) {
                    // Last entry is a concurrent group — add this task to it
                    slotDir = path.join(acceptedDir, last)
                } else {
                    // Last entry is sequential (or accepted/ is empty) — create a new group
                    slotDir = await createConcurrentGroupDir(acceptedDir)
                }

                const taskDir = path.join(slotDir, args.task_name)
                await mkdir(taskDir, { recursive: true })
                await writeFile(path.join(taskDir, "build.prompt.md"), args.instructions, "utf-8")

                const slotName = path.basename(slotDir)
                return successResponse(sid, toolName, `✅ Concurrent task '${slotName}/${args.task_name}' created`)
            } catch (err: any) {
                await failPlan(context.worktree, args.plan_name, `${toolName} failed to create task '${args.task_name}': ${err.message}`)
                return abortResponse(toolName, `failed to create concurrent task '${args.task_name}' for plan '${args.plan_name}': ${err.message}`)
            }
        },
    })

    /**
     * Spawns a new `orchestrate` agent session to orchestrate execution of a plan.
     *
     * Creates a fresh session titled "Orchestrate: <plan_name>", sends the plan name
     * as the initial prompt, and returns the session ID so it can be monitored.
     * The orchestrate agent takes over from there autonomously.
     */
    const autocode_build_orchestrate: ToolDefinition = tool({
        description:
            "Start the orchestration of tasks for the given plan_name. " +
            "Spawns a new orchestrate agent session and sends the plan_name as the sole initial message. " +
            "Returns { session_id } of the spawned session.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("Exact plan_name value returned by autocode_build_plan tool"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_build_orchestrate"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            try {
                const created = await client.session.create({
                    body: { title: `Orchestrate: ${args.plan_name}` },
                    throwOnError: true,
                })
                const sessionId = created.data.id

                // Fire-and-forget: send the plan_name as an XML element in the initial message to the
                // orchestrate agent. Using <plan_name> XML tags follows Anthropic's recommendation for
                // unambiguous structured parameter passing in agent prompts. The orchestrate agent parses
                // the tag content and uses it as the plan_name for all subsequent tool calls.
                // We do NOT await the prompt — the agent runs independently.
                client.session.prompt({
                    path: { id: sessionId },
                    body: {
                        agent: "orchestrate",
                        parts: [{ type: "text", text: `<plan_name>${args.plan_name}</plan_name>` }],
                    },
                    throwOnError: true,
                }).catch(() => {
                    // Ignore errors — the orchestrate agent session handles its own failures.
                })

                return successResponse(sid, toolName, { session_id: sessionId })
            } catch (err: any) {
                return abortResponse(toolName, `failed to spawn orchestrate session for plan '${args.plan_name}': ${err.message}`)
            }
        },
    })

    /**
     * Marks a plan as permanently failed by moving its directory from
     * `.autocode/build/<plan_name>` to `.autocode/failed/<plan_name>` and
     * writing a `failure.md` file with the provided reason.
     *
     * Idempotent: if this tool is called more than once for the same plan
     * in a session, subsequent calls are silently ignored (the directory
     * move is only attempted once).
     *
     * Call this tool when it is not possible to create a task for a plan.
     */
    const autocode_build_fail: ToolDefinition = tool({
        description:
            "Mark a plan as permanently failed. " +
            "Moves `.autocode/build/<plan_name>` to `.autocode/failed/<plan_name>` and " +
            "writes a `failure.md` file containing the reason for the failure. " +
            "Call this tool when it is not possible to create a task for the plan, " +
            "providing a clear human-readable reason for the failure. " +
            "This tool is idempotent: if called multiple times for the same plan, " +
            "only the first call performs the move — subsequent calls are ignored.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("Plan name as returned by autocode_build_plan"),
            reason: tool.schema
                .string()
                .describe("Clear human-readable explanation of why the plan cannot proceed"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_build_fail"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const reasonErr = validateNonEmpty(args.reason, sid, toolName, "reason")
            if (reasonErr) return reasonErr

            if (failedPlans.has(args.plan_name)) {
                return successResponse(sid, toolName, `ℹ️ Plan '${args.plan_name}' was already marked as failed — skipping`)
            }

            await failPlan(context.worktree, args.plan_name, args.reason)
            return successResponse(sid, toolName, `✅ Plan '${args.plan_name}' moved to .autocode/failed/ — failure.md written`)
        },
    })

    return {
        autocode_build_plan,
        autocode_build_next_task,
        autocode_build_concurrent_task,
        autocode_build_orchestrate,
        autocode_build_fail,
    }
}
