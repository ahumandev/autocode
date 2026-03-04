import { tool, ToolDefinition, PluginInput } from "@opencode-ai/plugin"
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "fs/promises"
import path from "path"
import { validateNonEmpty, retryResponse, abortResponse, successResponse } from "@/utils/validation"

type Client = PluginInput["client"]

// ─── types ───────────────────────────────────────────────────────────────────

type MessageEntry = {
    info: { role: string }
    parts: Array<{ type: string; text?: string }>
}

type FailureType = "task_session" | "test_session" | "test_verification" | "tool_error" | "task_failure"

type TaskFailure = {
    /** Human-readable error description */
    failure: string
    /** Absolute path to the session file written for this failure */
    sessionFile: string
    /** Session ID parsed from the session filename */
    sessionId: string
    /** Session ID of the build (explore) step — may differ from sessionId when the test failed */
    buildSessionId: string
    /**
     * Categorised failure type:
     *  - task_session      — explore session threw an error (API/crash)
     *  - test_session      — test session threw an error (API/crash)
     *  - test_verification — test ran fine but reported FAIL (wrong implementation)
     *  - tool_error        — tool-level error before any session (e.g. missing prompt file)
     */
    failureType: FailureType
    /**
     * Last 20 lines of the failing session output, or the exact error string for tool/session errors.
     */
    failureDetails: string
}

// ─── pure helpers (no IO) ────────────────────────────────────────────────────

/**
 * Format spawned session messages into a readable markdown document.
 */
function formatSessionMarkdown(prompt: string, messages: MessageEntry[]): string {
    const lines: string[] = []
    lines.push("# Session Record", "")
    lines.push("## Prompt", "", prompt, "", "---", "")
    lines.push("## Session", "")
    for (const { info, parts } of messages) {
        const roleLabel = info.role === "user" ? "User" : "Assistant"
        lines.push(`### ${roleLabel}`, "")
        for (const part of parts) {
            if ((part.type === "text" || part.type === "reasoning") && part.text) {
                lines.push(part.text, "")
            }
        }
    }
    return lines.join("\n")
}

/**
 * Parse a <success> or <failure> tag from the task agent's final response.
 * Returns { kind: "success", content } or { kind: "failure", content }.
 * Falls back to { kind: "success", content: "" } when neither tag is present
 * (graceful degradation for agents that don't emit the tag yet).
 */
function extractTaskResult(
    messages: MessageEntry[],
): { kind: "success"; content: string } | { kind: "failure"; content: string } {
    const assistant = messages.filter(m => m.info.role === "assistant")
    if (assistant.length === 0) {
        return { kind: "failure", content: "The assistant did not respond." }
    }
    const text = assistant[assistant.length - 1].parts
        .filter(p => p.type === "text")
        .map(p => p.text ?? "")
        .join("\n")

    const failureMatches = [...text.matchAll(/<failure>([\s\S]*?)<\/failure>/g)]
    const successMatches = [...text.matchAll(/<success>([\s\S]*?)<\/success>/g)]

    // Find the last occurrence of either tag
    const lastFailure = failureMatches.length > 0 ? failureMatches[failureMatches.length - 1] : null
    const lastSuccess = successMatches.length > 0 ? successMatches[successMatches.length - 1] : null

    if (lastFailure && lastSuccess) {
        // Return whichever appears last in the text
        const failureIndex = lastFailure.index ?? 0
        const successIndex = lastSuccess.index ?? 0
        if (failureIndex > successIndex) {
            return { kind: "failure", content: lastFailure[1].trim() }
        } else {
            return { kind: "success", content: lastSuccess[1].trim() }
        }
    }

    if (lastFailure) {
        return { kind: "failure", content: lastFailure[1].trim() }
    }

    if (lastSuccess) {
        return { kind: "success", content: lastSuccess[1].trim() }
    }

    // No tag found — assume success (backward compatibility)
    return { kind: "success", content: text }
}

/**
 * Generate a timestamp string in `YYYY-MM-DD_HH-mm-ss` format (local time).
 */
function makeTimestamp(): string {
    const now = new Date()
    const pad = (n: number, w = 2) => String(n).padStart(w, "0")
    return [
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`,
    ].join("_")
}

// ─── async helpers ───────────────────────────────────────────────────────────

/**
 * Scan a directory for an existing `session.{id}.md` file.
 * Returns the session ID string extracted from the filename, or null.
 */
async function findSessionId(dir: string): Promise<string | null> {
    const entries = await readdir(dir).catch(() => [] as string[])
    // Match session.{id}.md but NOT session.ok.* or session.fail.*
    const match = entries.find(e => /^session\.(?!ok\.|fail\.)(.+)\.md$/.test(e))
    if (!match) return null
    const m = match.match(/^session\.(.+)\.md$/)
    return m ? m[1] : null
}

/**
 * Write success.md or failure.md after removing any stale counterpart.
 * Always writes session.{sessionId}.md with the full session content.
 */
async function writeOutcomeFiles(
    dir: string,
    sessionId: string,
    sessionContent: string,
    outcome: { kind: "success" | "failure"; content: string },
): Promise<void> {
    // Always write session.{sessionId}.md
    await writeFile(path.join(dir, `session.${sessionId}.md`), sessionContent, "utf-8").catch(() => {})

    // Remove stale success.md and failure.md
    await unlink(path.join(dir, "success.md")).catch(() => {})
    await unlink(path.join(dir, "failure.md")).catch(() => {})

    // Write the outcome file
    const outFile = outcome.kind === "success" ? "success.md" : "failure.md"
    await writeFile(path.join(dir, outFile), outcome.content, "utf-8").catch(() => {})
}

/**
 * Returns the directory entry with the lowest numeric prefix in `planDir` that
 * has not yet started (i.e. still has the `XX-` prefix but no timestamp prefix
 * and is not hidden with a leading dot).
 *
 * Entries are sorted numerically by their leading two-digit order prefix.
 * Returns null when no pending tasks remain.
 */
async function findNextGroup(planDir: string): Promise<string | null> {
    const entries = await readdir(planDir).catch(() => [] as string[])
    // Pending tasks start with exactly two digits followed by a dash
    const pending = entries
        .filter(e => /^\d{2}-/.test(e))
        .sort((a, b) => {
            const na = parseInt(a.match(/^(\d+)/)?.[1] ?? "0", 10)
            const nb = parseInt(b.match(/^(\d+)/)?.[1] ?? "0", 10)
            return na - nb
        })
    return pending[0] ?? null
}

/**
 * Resolve the absolute path to a task directory within a plan.
 *
 * The plan may live in `.autocode/build/`, `.autocode/execute/`, or
 * `.autocode/review/`.  Within the plan directory tasks can be in any of
 * three states:
 *
 *   - Pending   — `XX-task_name`                (numeric prefix, no timestamp)
 *   - In-flight — `YYYY-MM-DD_HH-mm-ss_XX-task` (timestamp prefix)
 *   - Succeeded — `.YYYY-MM-DD_HH-mm-ss_XX-task` (dot-hidden, timestamp prefix)
 *   - Failed    — `YYYY-MM-DD_HH-mm-ss_XX-task.failed`
 *
 * Concurrent tasks live inside a group directory named `XX-concurrent_group`
 * (pending) or the timestamped/hidden variants thereof.
 *
 * With `taskName`:
 *   Searches all plan locations and all task states for a directory whose
 *   *base name* (after stripping the leading dot, timestamp prefix, and
 *   trailing `.failed`) matches `taskName`.  Returns the first match or null.
 *
 * Without `taskName`:
 *   Returns the directory of the lowest-numbered *pending* group in the plan
 *   (i.e. the next group to execute), or null if none remain.
 */
async function resolveTaskDir(
    worktree: string,
    planName: string,
    taskName?: string,
): Promise<string | null> {
    const bases = [
        path.join(worktree, ".autocode", "build",   planName),
        path.join(worktree, ".autocode", "execute",  planName),
        path.join(worktree, ".autocode", "review",   planName),
    ]

    if (taskName) {
        for (const base of bases) {
            const entries = await readdir(base).catch(() => [] as string[])
            for (const entry of entries) {
                const candidate = path.join(base, entry)
                // Strip leading dot, timestamp prefix, trailing .failed to get logical name
                const logical = stripTaskNameDecorations(entry)
                if (logical === taskName) {
                    return candidate
                }
                // Also search inside concurrent groups
                if (/concurrent_group/.test(logical)) {
                    const subEntries = await readdir(candidate).catch(() => [] as string[])
                    for (const sub of subEntries) {
                        if (!sub.startsWith(".") && sub === taskName) {
                            return path.join(candidate, sub)
                        }
                    }
                }
            }
        }
        return null
    }

    // No task_name — resolve the current (lowest-numbered pending) group
    for (const base of bases) {
        const next = await findNextGroup(base)
        if (next) return path.join(base, next)
    }
    return null
}

/**
 * Strip all runtime decorations from a task directory name to recover the
 * original logical name (as created by the build tool).
 *
 * Decorations removed (in order):
 *  1. Leading dot (hidden/completed marker)
 *  2. Leading `YYYY-MM-DD_HH-mm-ss_` timestamp
 *  3. Trailing `.failed`
 */
function stripTaskNameDecorations(name: string): string {
    // 1. Strip leading dot
    let n = name.startsWith(".") ? name.slice(1) : name
    // 2. Strip timestamp prefix: YYYY-MM-DD_HH-mm-ss_
    n = n.replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/, "")
    // 3. Strip trailing .failed
    if (n.endsWith(".failed")) n = n.slice(0, -".failed".length)
    return n
}

// ─── tool factory ────────────────────────────────────────────────────────────

export function createOrchestrateTools(client: Client): Record<string, ToolDefinition> {

    // ─── internal: execute one task directory ────────────────────────────────

    /**
     * Execute a single task directory end-to-end, managing directory renames
     * to reflect the current state:
     *
     *   Pending   → In-flight:  `XX-task`        → `YYYY-MM-DD_HH-mm-ss_XX-task`
     *   In-flight → Succeeded:  `YYYY-…_XX-task` → `.YYYY-…_XX-task`
     *   In-flight → Failed:     `YYYY-…_XX-task` → `YYYY-…_XX-task.failed`
     *
     * Build step:
     *   - If `success.md` already exists → skip (prior run succeeded).
     *   - If `failure.md` already exists → return failure immediately.
     *   - If `session.{id}.md` exists → try to reconnect with "continue".
     *   - Otherwise spawn a fresh `execute` session with `prompt.md`.
     *   - Writes `session.{id}.md` + `success.md` or `failure.md` via writeOutcomeFiles.
     *
     * Returns { finalDir, failure } where:
     *  - `finalDir` is the directory path after all renames.
     *  - `failure`  is null on success, or a TaskFailure object on failure.
     *
     * Always populates `buildSessionId` so callers can send fix instructions
     * to the build session even when the test is what failed.
     */
    async function executeTask(
        taskDir: string,
        taskDisplayName: string,
    ): Promise<{ finalDir: string; failure: TaskFailure | null }> {

        // ── Rename pending → in-flight ────────────────────────────────────────
        // The directory name may already have a timestamp prefix if this is a
        // resume after a crash (in-flight state survived).  Only rename when the
        // entry still looks pending (starts with two digits).
        const entryName = path.basename(taskDir)
        let inFlightDir: string

        if (/^\d{2}-/.test(entryName)) {
            // Still pending — prepend timestamp
            const ts = makeTimestamp()
            const newName = `${ts}_${entryName}`
            inFlightDir = path.join(path.dirname(taskDir), newName)
            await rename(taskDir, inFlightDir)
        } else {
            // Already in-flight (timestamp prefix present) — use as-is
            inFlightDir = taskDir
        }

        // ── Build step ───────────────────────────────────────────────────────

        const successMdPath = path.join(inFlightDir, "success.md")
        const failureMdPath = path.join(inFlightDir, "failure.md")

        // Priority 1: success.md already written
        try {
            await readFile(successMdPath, "utf-8")
            const doneDir = path.join(path.dirname(inFlightDir), `.${path.basename(inFlightDir)}`)
            await rename(inFlightDir, doneDir).catch(() => {})
            return { finalDir: doneDir, failure: null }
        } catch { /* not present */ }

        // Priority 2: failure.md already written
        try {
            const failureContent = await readFile(failureMdPath, "utf-8")
            const sessionId = await findSessionId(inFlightDir) ?? "prior_run"
            const failedDir = `${inFlightDir}.failed`
            await rename(inFlightDir, failedDir).catch(() => {})
            return {
                finalDir: failedDir,
                failure: {
                    failure: `Task '${taskDisplayName}' failed in a prior run`,
                    sessionFile: path.join(failedDir, "failure.md"),
                    sessionId,
                    buildSessionId: sessionId,
                    failureType: "task_failure" as FailureType,
                    failureDetails: failureContent,
                },
            }
        } catch { /* not present */ }

        // Priority 3 & 4: run or resume session
        let buildPrompt: string
        try {
            buildPrompt = await readFile(path.join(inFlightDir, "prompt.md"), "utf-8")
        } catch (err: any) {
            await writeOutcomeFiles(
                inFlightDir,
                "read_error",
                `# Error\n\nFailed to read prompt.md: ${err.message}\n`,
                { kind: "failure", content: `Failed to read prompt.md: ${err.message}` },
            )
            const failedDir = `${inFlightDir}.failed`
            await rename(inFlightDir, failedDir).catch(() => {})
            return {
                finalDir: failedDir,
                failure: {
                    failure: `Failed to read prompt.md for '${taskDisplayName}': ${err.message}`,
                    sessionFile: path.join(failedDir, "failure.md"),
                    sessionId: "read_error",
                    buildSessionId: "read_error",
                    failureType: "tool_error" as FailureType,
                    failureDetails: err.message,
                },
            }
        }

        let sid = "error"
        let buildMessages: MessageEntry[] = []

        // Priority 3: try to reconnect to a prior session
        const priorSessionId = await findSessionId(inFlightDir)
        let reconnected = false
        if (priorSessionId) {
            try {
                await client.session.prompt({
                    path: { id: priorSessionId },
                    body: {
                        agent: "execute",
                        parts: [{ type: "text", text: "continue" }],
                    },
                    throwOnError: true,
                })
                const resp = await client.session.messages({
                    path: { id: priorSessionId },
                    throwOnError: true,
                })
                sid = priorSessionId
                buildMessages = (resp.data ?? []) as MessageEntry[]
                reconnected = true
            } catch {
                // Reconnect failed — fall through to fresh run
            }
        }

        // Priority 4: fresh run (if not reconnected)
        if (!reconnected) {
            try {
                const created = await client.session.create({
                    body: { title: `Task: ${taskDisplayName}` },
                    throwOnError: true,
                })
                sid = created.data.id

                await client.session.prompt({
                    path: { id: sid },
                    body: {
                        agent: "execute",
                        parts: [{ type: "text", text: buildPrompt }],
                    },
                    throwOnError: true,
                })

                const resp = await client.session.messages({
                    path: { id: sid },
                    throwOnError: true,
                })
                buildMessages = (resp.data ?? []) as MessageEntry[]
            } catch (err: any) {
                const failure = `Build session failed for '${taskDisplayName}': ${err.message}`
                await writeOutcomeFiles(
                    inFlightDir,
                    sid,
                    `# Error\n\n${failure}\n`,
                    { kind: "failure", content: err.message },
                )
                const failedDir = `${inFlightDir}.failed`
                await rename(inFlightDir, failedDir).catch(() => {})
                return {
                    finalDir: failedDir,
                    failure: {
                        failure,
                        sessionFile: path.join(failedDir, "failure.md"),
                        sessionId: sid,
                        buildSessionId: sid,
                        failureType: "task_session" as FailureType,
                        failureDetails: err.message,
                    },
                }
            }
        }

        // ── Outcome handling (shared by reconnect and fresh run) ─────────────
        const executeResult = extractTaskResult(buildMessages)

        if (executeResult.kind === "failure") {
            const failure = `Task agent reported failure for '${taskDisplayName}': ${executeResult.content}`
            await writeOutcomeFiles(
                inFlightDir,
                sid,
                formatSessionMarkdown(buildPrompt, buildMessages),
                { kind: "failure", content: executeResult.content },
            )
            const failedDir = `${inFlightDir}.failed`
            await rename(inFlightDir, failedDir).catch(() => {})
            return {
                finalDir: failedDir,
                failure: {
                    failure,
                    sessionFile: path.join(failedDir, "failure.md"),
                    sessionId: sid,
                    buildSessionId: sid,
                    failureType: "task_failure" as FailureType,
                    failureDetails: executeResult.content,
                },
            }
        }

        // Success
        await writeOutcomeFiles(
            inFlightDir,
            sid,
            formatSessionMarkdown(buildPrompt, buildMessages),
            { kind: "success", content: executeResult.content.trim() },
        )

        // Mark succeeded — hide with leading dot
        const doneDir = path.join(path.dirname(inFlightDir), `.${path.basename(inFlightDir)}`)
        await rename(inFlightDir, doneDir).catch(() => {})
        return { finalDir: doneDir, failure: null }
    }

    // ─── tool: autocode_orchestrate_resume ──────────────────────────────────

    /**
     * Run every task in the plan to completion, then promote the plan to review.
     *
     * On the first call moves `.autocode/build/{plan}/` → `.autocode/execute/{plan}/`.
     *
     * Loops internally over all task groups (lowest numeric prefix first).
     * Sequential tasks run one at a time; concurrent groups run in parallel.
     *
     * Task directory lifecycle:
     *   Pending   `XX-task`                — not yet started
     *   In-flight `YYYY-MM-DD_HH-mm-ss_XX-task` — currently executing
     *   Succeeded `.YYYY-MM-DD_HH-mm-ss_XX-task` — completed (dot-hidden)
     *   Failed    `YYYY-MM-DD_HH-mm-ss_XX-task.failed` — failed, needs fixing
     *
     * On full completion moves `.autocode/execute/{plan}/` → `.autocode/review/{plan}/`.
     *
     * Return shapes:
     *   { done: true,  reviewPath }
     *   { done: false, success: false, task, session_id, build_session_id, reason, sessionFile }
     *   { done: false, success: false, group, failures: [{task, session_id, build_session_id, reason, sessionFile}] }
     */
    const autocode_orchestrate_resume: ToolDefinition = tool({
        description:
            "Run every task in the plan autonomously and promote the plan to review when finished. " +
            "Loops internally through all task groups (lowest numeric prefix first). " +
            "Sequential tasks run one at a time; concurrent groups run in parallel. " +
            "For each task: spawns an `execute` session (build) — skipped if `success.md` exists, " +
            "resumed via `session.{id}.md` if a prior run crashed without writing an outcome. " +
            "Outcome files written: `session.{id}.md` + `success.md` or `failure.md`. " +
            "Completed task directories are moved to `done/`. " +
            "On full completion moves `.autocode/build/{plan}/` to `.autocode/review/{plan}/`. " +
            "On failure returns `session_id` (the failing session) and `build_session_id` " +
            "(always the build session, even when the test is what failed) so the agent can " +
            "investigate and call `autocode_orchestrate_fix_task` to reconnect and fix.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("The plan name to orchestrate (as returned by autocode_build_plan)"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_resume"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return retryResponse(sid, toolName, "plan_name", "value is empty")

            const buildDir    = path.join(context.worktree, ".autocode", "build",   args.plan_name)
            const executeDir  = path.join(context.worktree, ".autocode", "execute", args.plan_name)
            const reviewDir   = path.join(context.worktree, ".autocode", "review",  args.plan_name)

            // Move build/ → execute/ on first resume (idempotent: skip if already moved)
            try {
                await readdir(buildDir)
                await mkdir(path.join(context.worktree, ".autocode", "execute"), { recursive: true })
                await rename(buildDir, executeDir)
            } catch (err: any) {
                // buildDir does not exist — either already moved to execute/ or invalid plan
                try {
                    await readdir(executeDir)
                } catch {
                    return abortResponse(toolName, `Failed to move '${args.plan_name}' to .autocode/execute: ${err}`)
                }
            }

            const planDir = executeDir

            while (true) {
                const groupName = await findNextGroup(planDir)

                if (groupName === null) {
                    // No more pending tasks — promote to review
                    await mkdir(path.join(context.worktree, ".autocode", "review"), { recursive: true })
                    await rename(planDir, reviewDir)

                    // Collect completed task names (dot-hidden entries)
                    const completedTasks: string[] = []
                    const reviewEntries = await readdir(reviewDir).catch(() => [] as string[])
                    for (const entry of reviewEntries.filter(e => e.startsWith(".")).sort()) {
                        const logical = stripTaskNameDecorations(entry)
                        if (/concurrent_group/.test(logical)) {
                            const subEntries = await readdir(path.join(reviewDir, entry)).catch(() => [] as string[])
                            for (const sub of subEntries.sort()) {
                                completedTasks.push(`${logical}/${sub}`)
                            }
                        } else {
                            completedTasks.push(logical)
                        }
                    }

                    return successResponse(sid, toolName, {
                        instruction: "Orchestration completed. Ask user to review.",
                        reviewPath: reviewDir,
                        completed_tasks: completedTasks,
                    })
                }

                const groupDir     = path.join(planDir, groupName)
                const isConcurrent = /^\d{2}-concurrent_group$/.test(groupName)

                if (isConcurrent) {
                    const subEntries = await readdir(groupDir).catch(() => [] as string[])
                    const taskNames  = subEntries.filter(e => !e.startsWith("."))

                    // Rename concurrent group dir to in-flight before executing sub-tasks
                    const ts = makeTimestamp()
                    const inFlightGroupName = `${ts}_${groupName}`
                    const inFlightGroupDir  = path.join(planDir, inFlightGroupName)
                    await rename(groupDir, inFlightGroupDir)

                    const results = await Promise.all(
                        taskNames.map(taskName =>
                            executeTask(
                                path.join(inFlightGroupDir, taskName),
                                `${groupName}/${taskName}`,
                            ).then(({ failure }) => ({ taskName, failure }))
                        )
                    )

                    const failures = results.filter(r => r.failure !== null)
                    if (failures.length > 0) {
                        // Mark the group dir as failed
                        const failedGroupDir = `${inFlightGroupDir}.failed`
                        await rename(inFlightGroupDir, failedGroupDir).catch(() => {})
                        return successResponse(sid, toolName, {
                            done: false,
                            success: false,
                            plan_name: args.plan_name,
                            group: groupName,
                            failures: failures.map(f => ({
                                task_name: `${groupName}/${f.taskName}`,
                                session_id: f.failure!.sessionId,
                                build_session_id: f.failure!.buildSessionId,
                                failure_type: f.failure!.failureType,
                                failure_details: f.failure!.failureDetails,
                                sessionFile: f.failure!.sessionFile,
                            })),
                        })
                    }

                    // All concurrent tasks succeeded — hide the group dir with a dot
                    const doneGroupDir = path.join(planDir, `.${inFlightGroupName}`)
                    await rename(inFlightGroupDir, doneGroupDir).catch(() => {})

                } else {
                    const { failure } = await executeTask(groupDir, groupName)
                    if (failure) {
                        return successResponse(sid, toolName, {
                            done: false,
                            success: false,
                            plan_name: args.plan_name,
                            task_name: groupName,
                            session_id: failure.sessionId,
                            build_session_id: failure.buildSessionId,
                            failure_type: failure.failureType,
                            failure_details: failure.failureDetails,
                            sessionFile: failure.sessionFile,
                        })
                    }
                    // executeTask already renamed to the dot-hidden path on success
                }
            }
        },
    })

    // ─── tool: autocode_orchestrate_fix_task ────────────────────────────────

    /**
     * Reconnect to an existing build session and send fix instructions.
     *
     * The `execute` agent in that session retains full context of what it
     * attempted, so the fix message can reference what went wrong and what to do.
     *
     * On completion writes `session.{id}.md` + `success.md` or `failure.md` so
     * the next call to `autocode_orchestrate_resume` can detect the outcome.
     */
    const autocode_orchestrate_fix_task: ToolDefinition = tool({
        description:
            "Reconnect to an existing build (execute) session and send fix instructions. " +
            "Use `build_session_id` from the failure response as `session_id`. " +
            "The agent in that session retains full context of what it tried before. " +
            "On completion writes `session.{id}.md` + `success.md` or `failure.md` so the next " +
            "`autocode_orchestrate_resume` call detects the outcome correctly. " +
            "Returns { success, summary } where summary is the agent's final response.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("Plan name (as returned by autocode_build_plan)"),
            task_name: tool.schema
                .string()
                .describe("Task name exactly as returned in the failure response (e.g. '01-create_model' or '02-concurrent_group/login_endpoint')"),
            session_id: tool.schema
                .string()
                .describe("The build_session_id from the failure response — the existing explore session to reconnect to"),
            fix_message: tool.schema
                .string()
                .describe("Fix instructions to send to the session. Include what failed and exactly what to do to correct it."),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_fix_task"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const taskNameErr = validateNonEmpty(args.task_name, sid, toolName, "task_name")
            if (taskNameErr) return taskNameErr

            const sessionIdErr = validateNonEmpty(args.session_id, sid, toolName, "session_id")
            if (sessionIdErr) return sessionIdErr

            const fixMessageErr = validateNonEmpty(args.fix_message, sid, toolName, "fix_message")
            if (fixMessageErr) return fixMessageErr

            const dir = await resolveTaskDir(context.worktree, args.plan_name, args.task_name)
            if (!dir) {
                return retryResponse(sid, toolName, "task_name", `match an existing task for plan '${args.plan_name}' — '${args.task_name}' was not found`)
            }

            try {
                await client.session.prompt({
                    path: { id: args.session_id },
                    body: {
                        agent: "explore",
                        parts: [{ type: "text", text: args.fix_message }],
                    },
                    throwOnError: true,
                })

                const resp = await client.session.messages({
                    path: { id: args.session_id },
                    throwOnError: true,
                })
                const messages = (resp.data ?? []) as MessageEntry[]

                const fixResult = extractTaskResult(messages)
                await writeOutcomeFiles(
                    dir,
                    args.session_id,
                    formatSessionMarkdown(args.fix_message, messages),
                    fixResult.kind === "success"
                        ? { kind: "success", content: fixResult.content }
                        : { kind: "failure", content: fixResult.content },
                )

                const assistant = messages.filter(m => m.info.role === "assistant")
                const summary = assistant.length > 0
                    ? assistant[assistant.length - 1].parts
                        .filter(p => p.type === "text")
                        .map(p => p.text ?? "")
                        .join("\n")
                        .slice(0, 500)
                    : "(no response)"

                const outcomeFile = fixResult.kind === "success" ? "success.md" : "failure.md"
                return successResponse(sid, toolName, { success: true, summary, sessionFile: path.join(dir, outcomeFile) })
            } catch (err: any) {
                return abortResponse(toolName, `fix session failed for task '${args.task_name}': ${err.message}`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_read_plan ───────────────────────────────

    const autocode_orchestrate_read_plan: ToolDefinition = tool({
        description:
            "Read the plan.md file for a given plan. " +
            "Use this to understand the original intent and background of what should be implemented.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("The plan name"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_read_plan"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            // Plan may still be in build/ (before first resume), execute/ (during execution), or review/ (after completion)
            const candidates = [
                path.join(context.worktree, ".autocode", "build",   args.plan_name, "plan.md"),
                path.join(context.worktree, ".autocode", "execute",  args.plan_name, "plan.md"),
                path.join(context.worktree, ".autocode", "review",   args.plan_name, "plan.md"),
            ]
            for (const p of candidates) {
                try {
                    const content = await readFile(p, "utf-8")
                    return successResponse(sid, toolName, content)
                } catch { /* try next */ }
            }
            return abortResponse(toolName, `plan.md not found for plan '${args.plan_name}' in build/, execute/, or review/`)
        },
    })

    // ─── tool: autocode_orchestrate_read_task_prompt ────────────────────────

    const autocode_orchestrate_read_task_prompt: ToolDefinition = tool({
        description:
            "Read the prompt.md file for a task to understand its original implementation instructions. " +
            "Without task_name reads the current (lowest-numbered) task in accepted/. " +
            "With task_name scans accepted/{task_name} then done/{task_name}.",
        args: {
            plan_name: tool.schema.string().describe("The plan name"),
            task_name: tool.schema
                .string()
                .optional()
                .describe("Task name (e.g. '01-create_model'). Omit to use the next pending task."),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_read_task_prompt"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const dir = await resolveTaskDir(context.worktree, args.plan_name, args.task_name)
            if (!dir) {
                return args.task_name
                    ? retryResponse(sid, toolName, "task_name", `match an existing task for plan '${args.plan_name}' — '${args.task_name}' was not found`)
                    : abortResponse(toolName, `no pending task found for plan '${args.plan_name}' — the plan state may be corrupted`)
            }
            try {
                const content = await readFile(path.join(dir, "prompt.md"), "utf-8")
                return successResponse(sid, toolName, content)
            } catch (err: any) {
                return abortResponse(toolName, `prompt.md not found in '${dir}': ${err.message}`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_review ──────────────────────────────────

    /**
     * Writes `review.md` with a human review report for a completed plan.
     * The plan should already be in `.autocode/review/` (promoted by resume).
     * Falls back to `.autocode/execute/` or `.autocode/build/` if not yet promoted.
     */
    const autocode_orchestrate_review: ToolDefinition = tool({
        description:
            "Write the final human review report (review.md) for a completed plan. " +
            "Call this after all tasks have completed and you have gathered work summaries. " +
            "The review should describe what was implemented, how to verify it, and any " +
            "unexpected work discovered during troubleshooting. " +
            "Returns success confirmation or { error } on failure.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("Plan name (as returned by autocode_build_plan)"),
            review_md_content: tool.schema
                .string()
                .describe("Human review report content in markdown format"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_review"

            // ── input validation ──────────────────────────────────────────────
            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const contentErr = validateNonEmpty(args.review_md_content, sid, toolName, "review_md_content")
            if (contentErr) return contentErr

            // ── find the plan directory (review/ first, then execute/, then build/) ──────────
            const candidates = [
                path.join(context.worktree, ".autocode", "review",  args.plan_name),
                path.join(context.worktree, ".autocode", "execute", args.plan_name),
                path.join(context.worktree, ".autocode", "build",   args.plan_name),
            ]
            let planDir: string | null = null
            for (const candidate of candidates) {
                try {
                    await readdir(candidate)
                    planDir = candidate
                    break
                } catch { /* try next */ }
            }

            if (!planDir) {
                return retryResponse(
                    sid,
                    toolName,
                    "plan_name",
                    `match an existing plan directory — '${args.plan_name}' was not found in review/, execute/, or build/`,
                )
            }

            // ── write review.md ───────────────────────────────────────────────
            try {
                await writeFile(
                    path.join(planDir, "review.md"),
                    args.review_md_content,
                    "utf-8",
                )
                return successResponse(sid, toolName, `Review report written for plan '${args.plan_name}'`)
            } catch (err: any) {
                return abortResponse(toolName, `failed to write review for plan '${args.plan_name}': ${err.message}`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_list ────────────────────────────────────

    /**
     * List all plans available for orchestration in `.autocode/build/`.
     *
     * Returns an array of plan directory names (subdirectories of `.autocode/build/`).
     * Each entry represents a plan that has been built but not yet started or promoted.
     */
    const autocode_orchestrate_list: ToolDefinition = tool({
        description:
            "List all plans available for orchestration in .autocode/build/. " +
            "Returns an array of plan names (directory names) that can be passed to " +
            "autocode_orchestrate_resume to start or resume execution.",
        args: {},
        async execute(_args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_list"
            const buildDir = path.join(context.worktree, ".autocode", "build")
            try {
                const entries = await readdir(buildDir, { withFileTypes: true })
                const plans = entries
                    .filter(e => e.isDirectory())
                    .map(e => e.name)
                    .sort()
                return successResponse(sid, toolName, { plans })
            } catch (err: any) {
                if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                    return successResponse(sid, toolName, { plans: [] })
                }
                return abortResponse(toolName, `failed to list plans in .autocode/build/: ${err.message}`)
            }
        },
    })

    // ─── exports ─────────────────────────────────────────────────────────────

    return {
        autocode_orchestrate_list,
        autocode_orchestrate_resume,
        autocode_orchestrate_fix_task,
        autocode_orchestrate_review,
        autocode_orchestrate_read_plan,
        autocode_orchestrate_read_task_prompt
    }
}
