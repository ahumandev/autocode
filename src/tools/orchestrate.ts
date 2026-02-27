import { tool, ToolDefinition, PluginInput } from "@opencode-ai/plugin"
import { mkdir, readdir, readFile, rename, writeFile } from "fs/promises"
import path from "path"
import { validateNonEmpty, retryResponse, abortResponse, successResponse } from "../utils/validation"

type Client = PluginInput["client"]

// ─── types ───────────────────────────────────────────────────────────────────

type MessageEntry = {
    info: { role: string }
    parts: Array<{ type: string; text?: string }>
}

type FailureType = "task_session" | "test_session" | "test_verification" | "tool_error" | "execute_failure"

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
 * Inspect the last assistant message to determine whether the test session passed.
 * Convention (from test_prompt template): agent ends its response with "PASS" or "FAIL".
 */
function extractTestResult(messages: MessageEntry[]): { passed: boolean; reason: string } {
    const assistant = messages.filter(m => m.info.role === "assistant")
    if (assistant.length === 0) {
        return { passed: false, reason: "No assistant response found in test session." }
    }
    const last = assistant[assistant.length - 1]
    const text = last.parts
        .filter(p => p.type === "text")
        .map(p => p.text ?? "")
        .join("\n")
    if (text.toUpperCase().includes("FAIL")) {
        return { passed: false, reason: text.slice(0, 1000) }
    }
    return { passed: true, reason: text.slice(0, 500) }
}

/**
 * Parse the session ID out of a session filename.
 * File naming: `{task|test}.{success|failed}.{session_id}.md`
 */
function extractSessionId(filePath: string): string {
    const basename = path.basename(filePath)
    const match = basename.match(/^(?:task|test)\.(?:success|failed)\.(.+)\.md$/)
    return match?.[1] ?? "unknown"
}

/**
 * Extract a named section from a session markdown file, with optional pagination.
 *
 * @param section  "all" | "prompt" | "session" | "last_assistant"
 * @param offset   1-indexed line number to start from (default 1)
 * @param limit    Max number of lines to return (default 200)
 */
function extractSection(content: string, section: string, offset: number, limit: number): string {
    let text: string

    if (section === "prompt") {
        const start = content.indexOf("## Prompt")
        if (start === -1) return "(no Prompt section found)"
        const end = content.indexOf("\n---", start)
        text = (end === -1 ? content.slice(start) : content.slice(start, end)).trim()
        return text // prompt is short — no pagination needed
    }

    if (section === "session") {
        const start = content.indexOf("## Session")
        if (start === -1) return "(no Session section found)"
        text = content.slice(start)
    } else if (section === "last_assistant") {
        const idx = content.lastIndexOf("### Assistant")
        if (idx === -1) return "(no Assistant response found)"
        return content.slice(idx).trim() // single block — no pagination needed
    } else {
        text = content // "all"
    }

    return paginate(text, offset, limit)
}

/**
 * Parse a <success> or <failure> tag from the execute agent's final response.
 * Returns { kind: "success", content } or { kind: "failure", content }.
 * Falls back to { kind: "success", content: "" } when neither tag is present
 * (graceful degradation for agents that don't emit the tag yet).
 */
function extractExecuteResult(
    messages: MessageEntry[],
): { kind: "success"; content: string } | { kind: "failure"; content: string } {
    const assistant = messages.filter(m => m.info.role === "assistant")
    if (assistant.length === 0) {
        return { kind: "failure", content: "No assistant response found in execute session." }
    }
    const text = assistant[assistant.length - 1].parts
        .filter(p => p.type === "text")
        .map(p => p.text ?? "")
        .join("\n")

    const failureMatch = text.match(/<failure>([\s\S]*?)<\/failure>/)
    if (failureMatch) {
        return { kind: "failure", content: failureMatch[1].trim() }
    }

    const successMatch = text.match(/<success>([\s\S]*?)<\/success>/)
    if (successMatch) {
        return { kind: "success", content: successMatch[1].trim() }
    }

    // No tag found — assume success (backward compatibility)
    return { kind: "success", content: "" }
}

/** Return the last `n` non-blank lines from a block of text. */
function lastNLines(text: string, n: number): string {
    return text
        .split("\n")
        .filter(l => l.trim() !== "")
        .slice(-n)
        .join("\n")
}

function paginate(text: string, offset: number, limit: number): string {
    const lines = text.split("\n")
    const start = Math.max(0, offset - 1)
    const end   = start + limit
    const slice = lines.slice(start, end)
    const remaining = lines.length - end
    if (remaining > 0) {
        slice.push(`\n[${remaining} more lines — call again with offset=${end + 1} to continue]`)
    }
    return slice.join("\n")
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
 * Scan a directory for an existing session file matching a given prefix.
 * File naming: `{prefix}.{session_id}.md`
 * Returns the full path of the first match, or null.
 */
async function findSessionFile(
    dir: string,
    prefix: "task.success" | "task.failed" | "test.success" | "test.failed",
): Promise<string | null> {
    const entries = await readdir(dir).catch(() => [] as string[])
    const match = entries.find(e => e.startsWith(`${prefix}.`) && e.endsWith(".md"))
    return match ? path.join(dir, match) : null
}

/**
 * Find a session file by its ID, regardless of success/failed status.
 * Useful when the caller knows the ID but not the outcome.
 */
async function findSessionFileById(
    dir: string,
    filePrefix: "task" | "test",
    sessionId: string,
): Promise<string | null> {
    const entries = await readdir(dir).catch(() => [] as string[])
    const match = entries.find(e =>
        e.startsWith(`${filePrefix}.`) &&
        e.includes(`.${sessionId}.`) &&
        e.endsWith(".md")
    )
    return match ? path.join(dir, match) : null
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
 *   - In-flight — `YYYY-MM-DD_HH-mm-ss-XX-task` (timestamp prefix)
 *   - Succeeded — `.YYYY-MM-DD_HH-mm-ss-XX-task` (dot-hidden, timestamp prefix)
 *   - Failed    — `YYYY-MM-DD_HH-mm-ss-XX-task.failed`
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
 *  2. Leading `YYYY-MM-DD_HH-mm-ss-` timestamp
 *  3. Trailing `.failed`
 */
function stripTaskNameDecorations(name: string): string {
    // 1. Strip leading dot
    let n = name.startsWith(".") ? name.slice(1) : name
    // 2. Strip timestamp prefix: YYYY-MM-DD_HH-mm-ss-
    n = n.replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-/, "")
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
     *   Pending   → In-flight:  `XX-task`        → `YYYY-MM-DD_HH-mm-ss-XX-task`
     *   In-flight → Succeeded:  `YYYY-…-XX-task` → `.YYYY-…-XX-task`
     *   In-flight → Failed:     `YYYY-…-XX-task` → `YYYY-…-XX-task.failed`
     *
     * Build step:
     *   - If `task.success.{id}.md` already exists → skip (prior run succeeded).
     *   - Otherwise spawn an `explore` session with `build.prompt.md`.
     *   - Write `task.success.{id}.md` on success, `task.failed.{id}.md` on failure.
     *
     * Test step (only when `test.prompt.md` exists):
     *   - If `test.success.{id}.md` already exists → skip.
     *   - Otherwise spawn a `test` session.
     *   - Write `test.success.{id}.md` on pass, `test.failed.{id}.md` on fail.
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
            const newName = `${ts}-${entryName}`
            inFlightDir = path.join(path.dirname(taskDir), newName)
            await rename(taskDir, inFlightDir)
        } else {
            // Already in-flight (timestamp prefix present) — use as-is
            inFlightDir = taskDir
        }

        // ── Build step ───────────────────────────────────────────────────────

        let buildSessionId: string

        const existingBuildSuccess = await findSessionFile(inFlightDir, "task.success")
        if (existingBuildSuccess) {
            // Already succeeded on a prior run — reuse its session ID
            buildSessionId = extractSessionId(existingBuildSuccess)
        } else {
            let buildPrompt: string
            try {
                buildPrompt = await readFile(path.join(inFlightDir, "build.prompt.md"), "utf-8")
            } catch (err: any) {
                const failFile = path.join(inFlightDir, "task.failed.read_error.md")
                await writeFile(
                    failFile,
                    `# Session Record\n\n## Error\n\nFailed to read build.prompt.md: ${err.message}\n`,
                    "utf-8",
                ).catch(() => {})
                // Mark as failed
                const failedDir = `${inFlightDir}.failed`
                await rename(inFlightDir, failedDir).catch(() => {})
                return {
                    finalDir: failedDir,
                    failure: {
                        failure: `Failed to read build.prompt.md for '${taskDisplayName}': ${err.message}`,
                        sessionFile: failFile,
                        sessionId: "read_error",
                        buildSessionId: "read_error",
                        failureType: "tool_error" as FailureType,
                        failureDetails: err.message,
                    },
                }
            }

            let sid = "error"
            try {
                const created = await client.session.create({
                    body: { title: `Execute: ${taskDisplayName}` },
                    throwOnError: true,
                })
                sid = created.data.id

                await client.session.prompt({
                    path: { id: sid },
                    body: {
                        agent: "explore",
                        parts: [{ type: "text", text: buildPrompt }],
                    },
                    throwOnError: true,
                })

                const resp = await client.session.messages({
                    path: { id: sid },
                    throwOnError: true,
                })
                const buildMessages = (resp.data ?? []) as MessageEntry[]

                const executeResult = extractExecuteResult(buildMessages)

                if (executeResult.kind === "failure") {
                    const failure = `Execute agent reported failure for '${taskDisplayName}': ${executeResult.content}`
                    const failFile = path.join(inFlightDir, `task.failed.${sid}.md`)
                    await writeFile(
                        failFile,
                        formatSessionMarkdown(buildPrompt, buildMessages),
                        "utf-8",
                    ).catch(() => {})
                    const failedDir = `${inFlightDir}.failed`
                    await rename(inFlightDir, failedDir).catch(() => {})
                    return {
                        finalDir: failedDir,
                        failure: {
                            failure,
                            sessionFile: failFile,
                            sessionId: sid,
                            buildSessionId: sid,
                            failureType: "execute_failure" as FailureType,
                            failureDetails: executeResult.content,
                        },
                    }
                }

                await writeFile(
                    path.join(inFlightDir, `task.success.${sid}.md`),
                    formatSessionMarkdown(buildPrompt, buildMessages),
                    "utf-8",
                )

                // Write work.md summarising what was implemented
                await writeFile(
                    path.join(inFlightDir, "work.md"),
                    `# Work Summary\n\n${executeResult.content}\n`,
                    "utf-8",
                ).catch(() => {})

                buildSessionId = sid
            } catch (err: any) {
                const failure = `Build session failed for '${taskDisplayName}': ${err.message}`
                const failFile = path.join(inFlightDir, `task.failed.${sid}.md`)
                await writeFile(
                    failFile,
                    `# Session Record\n\n## Error\n\n${failure}\n`,
                    "utf-8",
                ).catch(() => {})
                const failedDir = `${inFlightDir}.failed`
                await rename(inFlightDir, failedDir).catch(() => {})
                return {
                    finalDir: failedDir,
                    failure: {
                        failure,
                        sessionFile: failFile,
                        sessionId: sid,
                        buildSessionId: sid,
                        failureType: "task_session" as FailureType,
                        failureDetails: err.message,
                    },
                }
            }
        }

        // ── Test step ────────────────────────────────────────────────────────

        let testPrompt: string
        try {
            testPrompt = await readFile(path.join(inFlightDir, "test.prompt.md"), "utf-8")
        } catch {
            // No test prompt → mark succeeded and return
            const doneDir = path.join(path.dirname(inFlightDir), `.${path.basename(inFlightDir)}`)
            await rename(inFlightDir, doneDir).catch(() => {})
            return { finalDir: doneDir, failure: null }
        }

        const existingTestSuccess = await findSessionFile(inFlightDir, "test.success")
        if (existingTestSuccess) {
            // Already tested and passed — mark succeeded
            const doneDir = path.join(path.dirname(inFlightDir), `.${path.basename(inFlightDir)}`)
            await rename(inFlightDir, doneDir).catch(() => {})
            return { finalDir: doneDir, failure: null }
        }

        let testSid = "error"
        let testMessages: MessageEntry[] = []
        try {
            const created = await client.session.create({
                body: { title: `Test: ${taskDisplayName}` },
                throwOnError: true,
            })
            testSid = created.data.id

            await client.session.prompt({
                path: { id: testSid },
                body: {
                    agent: "test",
                    parts: [{ type: "text", text: testPrompt }],
                },
                throwOnError: true,
            })

            const resp = await client.session.messages({
                path: { id: testSid },
                throwOnError: true,
            })
            testMessages = (resp.data ?? []) as MessageEntry[]
        } catch (err: any) {
            const failure = `Test session failed for '${taskDisplayName}': ${err.message}`
            const failFile = path.join(inFlightDir, `test.failed.${testSid}.md`)
            await writeFile(
                failFile,
                `# Session Record\n\n## Error\n\n${failure}\n`,
                "utf-8",
            ).catch(() => {})
            const failedDir = `${inFlightDir}.failed`
            await rename(inFlightDir, failedDir).catch(() => {})
            return {
                finalDir: failedDir,
                failure: {
                    failure,
                    sessionFile: failFile,
                    sessionId: testSid,
                    buildSessionId,
                    failureType: "test_session" as FailureType,
                    failureDetails: err.message,
                },
            }
        }

        const result = extractTestResult(testMessages)
        if (!result.passed) {
            const failFile = path.join(inFlightDir, `test.failed.${testSid}.md`)
            await writeFile(failFile, formatSessionMarkdown(testPrompt, testMessages), "utf-8")

            // Collect the last 20 meaningful lines from the agent's final FAIL report
            const lastAssistantText = testMessages
                .filter(m => m.info.role === "assistant")
                .at(-1)?.parts
                .filter(p => p.type === "text")
                .map(p => p.text ?? "")
                .join("\n") ?? ""

            const failedDir = `${inFlightDir}.failed`
            await rename(inFlightDir, failedDir).catch(() => {})
            return {
                finalDir: failedDir,
                failure: {
                    failure: `Test FAILED for '${taskDisplayName}'.`,
                    sessionFile: failFile,
                    sessionId: testSid,
                    buildSessionId,
                    failureType: "test_verification" as FailureType,
                    failureDetails: lastNLines(lastAssistantText, 20),
                },
            }
        }

        await writeFile(
            path.join(inFlightDir, `test.success.${testSid}.md`),
            formatSessionMarkdown(testPrompt, testMessages),
            "utf-8",
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
     *   In-flight `YYYY-MM-DD_HH-mm-ss-XX-task` — currently executing
     *   Succeeded `.YYYY-MM-DD_HH-mm-ss-XX-task` — completed (dot-hidden)
     *   Failed    `YYYY-MM-DD_HH-mm-ss-XX-task.failed` — failed, needs fixing
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
            "For each task: spawns an `explore` session (build) — skipped if `task.success.*.md` exists " +
            "— then a `test` session if `test.prompt.md` exists — skipped if `test.success.*.md` exists. " +
            "Session files written: `task.success/failed.{id}.md`, `test.success/failed.{id}.md`. " +
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
                    for (const entry of reviewEntries.filter(e => e.startsWith(".") && e !== ".review.md").sort()) {
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
                    const inFlightGroupName = `${ts}-${groupName}`
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
     * The `explore` agent in that session retains full context of what it
     * attempted, so the fix message can reference what went wrong and what to do.
     *
     * On completion writes `task.success.{session_id}.md` so the next call to
     * `autocode_orchestrate_resume` skips the build step and runs only the test.
     */
    const autocode_orchestrate_fix_task: ToolDefinition = tool({
        description:
            "Reconnect to an existing build (explore) session and send fix instructions. " +
            "Use `build_session_id` from the failure response as `session_id`. " +
            "The agent in that session retains full context of what it tried before. " +
            "On completion writes `task.success.{session_id}.md` so the next " +
            "`autocode_orchestrate_resume` call skips the build and runs the test. " +
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

                // Write task.success.{id}.md — tells resume the build step is done
                const successFile = path.join(dir, `task.success.${args.session_id}.md`)
                await writeFile(
                    successFile,
                    formatSessionMarkdown(args.fix_message, messages),
                    "utf-8",
                )

                const assistant = messages.filter(m => m.info.role === "assistant")
                const summary = assistant.length > 0
                    ? assistant[assistant.length - 1].parts
                        .filter(p => p.type === "text")
                        .map(p => p.text ?? "")
                        .join("\n")
                        .slice(0, 500)
                    : "(no response)"

                return successResponse(sid, toolName, { success: true, summary, sessionFile: successFile })
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
            "Read the build.prompt.md file for a task to understand its original implementation instructions. " +
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
                const content = await readFile(path.join(dir, "build.prompt.md"), "utf-8")
                return successResponse(sid, toolName, content)
            } catch (err: any) {
                return abortResponse(toolName, `build.prompt.md not found in '${dir}': ${err.message}`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_read_task_session ───────────────────────

    const autocode_orchestrate_read_task_session: ToolDefinition = tool({
        description:
            "Read a section of the task (build) session file — either `task.success.{id}.md` or `task.failed.{id}.md`. " +
            "Without task_name reads the current (lowest-numbered) task in accepted/. " +
            "With task_name scans accepted/{task_name} then done/{task_name}. " +
            "Use `section` to target the relevant part of a potentially large file:\n" +
            "  • `prompt`         — the original prompt that was sent to the explore agent\n" +
            "  • `last_assistant` — only the final assistant response (most useful for diagnosing failures)\n" +
            "  • `session`        — the full session transcript (paginated with offset/limit)\n" +
            "  • `all`            — the entire file (paginated with offset/limit)",
        args: {
            plan_name: tool.schema.string().describe("The plan name"),
            task_name: tool.schema
                .string()
                .optional()
                .describe("Task name (e.g. '01-create_model'). Omit to use the next pending task."),
            session_id: tool.schema.string().describe("The build_session_id from the failure response"),
            section: tool.schema
                .enum(["all", "prompt", "session", "last_assistant"])
                .describe("Which part of the session file to read"),
            offset: tool.schema
                .number()
                .int()
                .positive()
                .optional()
                .describe("1-indexed line to start from (default: 1). Use with section=all or session to paginate."),
            limit: tool.schema
                .number()
                .int()
                .positive()
                .optional()
                .describe("Max lines to return (default: 200)"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_read_task_session"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const sessionIdErr = validateNonEmpty(args.session_id, sid, toolName, "session_id")
            if (sessionIdErr) return sessionIdErr

            const sectionErr = validateNonEmpty(args.section, sid, toolName, "section")
            if (sectionErr) return sectionErr

            const dir = await resolveTaskDir(context.worktree, args.plan_name, args.task_name)
            if (!dir) {
                return args.task_name
                    ? retryResponse(sid, toolName, "task_name", `match an existing task for plan '${args.plan_name}' — '${args.task_name}' was not found`)
                    : abortResponse(toolName, `no pending task found for plan '${args.plan_name}' — the plan state may be corrupted`)
            }
            const filePath = await findSessionFileById(dir, "task", args.session_id)
            if (!filePath) {
                return retryResponse(sid, toolName, "session_id", `match an existing task session file in '${dir}' — no file found for session_id '${args.session_id}'`)
            }
            try {
                const content = await readFile(filePath, "utf-8")
                return successResponse(sid, toolName, extractSection(content, args.section, args.offset ?? 1, args.limit ?? 200))
            } catch (err: any) {
                return abortResponse(toolName, `failed to read session file '${filePath}': ${err.message}`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_read_test_prompt ────────────────────────

    const autocode_orchestrate_read_test_prompt: ToolDefinition = tool({
        description:
            "Read the test.prompt.md file for a task to understand what the test is verifying. " +
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
            const toolName = "autocode_orchestrate_read_test_prompt"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const dir = await resolveTaskDir(context.worktree, args.plan_name, args.task_name)
            if (!dir) {
                return args.task_name
                    ? retryResponse(sid, toolName, "task_name", `match an existing task for plan '${args.plan_name}' — '${args.task_name}' was not found`)
                    : abortResponse(toolName, `no pending task found for plan '${args.plan_name}' — the plan state may be corrupted`)
            }
            try {
                const content = await readFile(path.join(dir, "test.prompt.md"), "utf-8")
                return successResponse(sid, toolName, content)
            } catch (err: any) {
                return abortResponse(toolName, `test.prompt.md not found in '${dir}': ${err.message}`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_read_test_session ───────────────────────

    const autocode_orchestrate_read_test_session: ToolDefinition = tool({
        description:
            "Read a section of the test session file — either `test.success.{id}.md` or `test.failed.{id}.md`. " +
            "Without task_name reads the current (lowest-numbered) task in accepted/. " +
            "With task_name scans accepted/{task_name} then done/{task_name}. " +
            "Use `section` to target the relevant part of a potentially large file:\n" +
            "  • `prompt`         — the test prompt that was sent to the test agent\n" +
            "  • `last_assistant` — only the final PASS/FAIL report (most useful for diagnosing failures)\n" +
            "  • `session`        — the full session transcript (paginated with offset/limit)\n" +
            "  • `all`            — the entire file (paginated with offset/limit)",
        args: {
            plan_name: tool.schema.string().describe("The plan name"),
            task_name: tool.schema
                .string()
                .optional()
                .describe("Task name (e.g. '01-create_model'). Omit to use the next pending task."),
            session_id: tool.schema.string().describe("The session_id from the failure response (test session ID)"),
            section: tool.schema
                .enum(["all", "prompt", "session", "last_assistant"])
                .describe("Which part of the session file to read"),
            offset: tool.schema
                .number()
                .int()
                .positive()
                .optional()
                .describe("1-indexed line to start from (default: 1)"),
            limit: tool.schema
                .number()
                .int()
                .positive()
                .optional()
                .describe("Max lines to return (default: 200)"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_read_test_session"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const sessionIdErr = validateNonEmpty(args.session_id, sid, toolName, "session_id")
            if (sessionIdErr) return sessionIdErr

            const sectionErr = validateNonEmpty(args.section, sid, toolName, "section")
            if (sectionErr) return sectionErr

            const dir = await resolveTaskDir(context.worktree, args.plan_name, args.task_name)
            if (!dir) {
                return args.task_name
                    ? retryResponse(sid, toolName, "task_name", `match an existing task for plan '${args.plan_name}' — '${args.task_name}' was not found`)
                    : abortResponse(toolName, `no pending task found for plan '${args.plan_name}' — the plan state may be corrupted`)
            }
            const filePath = await findSessionFileById(dir, "test", args.session_id)
            if (!filePath) {
                return retryResponse(sid, toolName, "session_id", `match an existing test session file in '${dir}' — no file found for session_id '${args.session_id}'`)
            }
            try {
                const content = await readFile(filePath, "utf-8")
                return successResponse(sid, toolName, extractSection(content, args.section, args.offset ?? 1, args.limit ?? 200))
            } catch (err: any) {
                return abortResponse(toolName, `failed to read session file '${filePath}': ${err.message}`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_read_work ───────────────────────────────

    const autocode_orchestrate_read_work: ToolDefinition = tool({
        description:
            "Read the work.md file for a task to review what the execute agent implemented. " +
            "Without task_name reads the current (lowest-numbered) task in accepted/. " +
            "With task_name scans accepted/{task_name} then done/{task_name}. " +
            "Returns the work summary written by the execute agent on successful task completion.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("The plan name"),
            task_name: tool.schema
                .string()
                .optional()
                .describe("Task name (e.g. '01-create_model'). Omit to use the next pending task."),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_read_work"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const dir = await resolveTaskDir(context.worktree, args.plan_name, args.task_name)
            if (!dir) {
                return args.task_name
                    ? retryResponse(sid, toolName, "task_name", `match an existing task for plan '${args.plan_name}' — '${args.task_name}' was not found`)
                    : abortResponse(toolName, `no pending task found for plan '${args.plan_name}' — the plan state may be corrupted`)
            }
            try {
                const content = await readFile(path.join(dir, "work.md"), "utf-8")
                return successResponse(sid, toolName, content)
            } catch (err: any) {
                return abortResponse(toolName, `work.md not found in '${dir}': ${err.message}`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_review ──────────────────────────────────

    /**
     * Writes `.review.md` with a human review report for a completed plan.
     * The plan should already be in `.autocode/review/` (promoted by resume).
     * Falls back to `.autocode/execute/` or `.autocode/build/` if not yet promoted.
     */
    const autocode_orchestrate_review: ToolDefinition = tool({
        description:
            "Write the final human review report (.review.md) for a completed plan. " +
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

            // ── write .review.md ──────────────────────────────────────────────
            try {
                await writeFile(
                    path.join(planDir, ".review.md"),
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
        autocode_orchestrate_read_task_prompt,
        autocode_orchestrate_read_task_session,
        autocode_orchestrate_read_test_prompt,
        autocode_orchestrate_read_test_session,
        autocode_orchestrate_read_work,
    }
}
