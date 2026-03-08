import { tool, ToolDefinition, PluginInput } from "@opencode-ai/plugin"
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "fs/promises"
import path from "path"
import { validateNonEmpty, retryResponse, abortResponse, successResponse } from "@/utils/validation"

type Client = PluginInput["client"]

// ─── types ───────────────────────────────────────────────────────────────────

type MessageEntry = {
    info: { role: string }
    parts: Array<{ type: string; text?: string }>
}

type FailureType = "task_session" | "test_session" | "test_verification" | "tool_error" | "task_failure"

type StepInfo = {
    entry: string
    dirPath: string
    timestamp: string
    stepNumber: string
    description: string
    outcome:
        | { kind: "success"; content: string; completedAt: string }
        | { kind: "failure"; content: string }
        | { kind: "incomplete" }
}

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

/**
 * Parse a human-readable timestamp from a task directory entry name.
 * Directory names use `YYYY-MM-DD_HH-mm-ss_` prefix; converts to `YYYY-MM-DD HH:mm:ss`.
 */
function parseEntryTimestamp(entry: string): string {
    const s = entry.startsWith(".") ? entry.slice(1) : entry
    const m = s.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_/)
    if (!m) return "—"
    return `${m[1]} ${m[2]}:${m[3]}:${m[4]}`
}

/**
 * Build the markdown review report from a list of step infos.
 */
function buildReviewMarkdown(planName: string, steps: StepInfo[]): string {
    const lines: string[] = []
    lines.push(`# ${planName}`, "")
    lines.push("## Progress", "")
    lines.push("| Timestamp | Step | Description | Completed |")
    lines.push("|-----------|------|-------------|-----------|")
    for (const s of steps) {
        const completed =
            s.outcome.kind === "success" ? s.outcome.completedAt :
            s.outcome.kind === "failure" ? "Failure" :
            "Incomplete"
        lines.push(`| ${s.timestamp} | ${s.stepNumber} | ${s.description} | ${completed} |`)
    }
    lines.push("")
    lines.push("## Details", "")
    for (const s of steps) {
        if (s.outcome.kind === "incomplete") continue
        lines.push(`### ${s.stepNumber} — ${s.description}`, "")
        lines.push(s.outcome.content, "")
    }
    return lines.join("\n")
}

// ─── async helpers ───────────────────────────────────────────────────────────

/**
 * Return the mtime of a file as a `YYYY-MM-DD HH:mm:ss` string.
 */
async function fileMtime(filePath: string): Promise<string> {
    try {
        const s = await stat(filePath)
        const d = s.mtime
        const pad = (n: number) => String(n).padStart(2, "0")
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    } catch {
        return "—"
    }
}

async function readStepOutcome(dirPath: string): Promise<StepInfo["outcome"]> {
    try {
        const content = await readFile(path.join(dirPath, "success.md"), "utf-8")
        const completedAt = await fileMtime(path.join(dirPath, "success.md"))
        return { kind: "success", content, completedAt }
    } catch {}
    try {
        const content = await readFile(path.join(dirPath, "failure.md"), "utf-8")
        return { kind: "failure", content }
    } catch {}
    return { kind: "incomplete" }
}

/**
 * Walk all task entries in a plan directory and collect StepInfo records.
 * Handles pending, in-flight, succeeded, and failed task states.
 * Recurses into concurrent groups.
 */
async function collectSteps(planDir: string): Promise<StepInfo[]> {
    const steps: StepInfo[] = []
    const entries = await readdir(planDir).catch(() => [] as string[])

    for (const entry of entries) {
        // Skip deleted steps
        if (entry.endsWith(".deleted")) continue
        const logical = stripTaskNameDecorations(entry)
        if (logical.endsWith(".deleted")) continue
        const stepMatch = logical.match(/^(\d{2})-(.+)$/)
        if (!stepMatch) continue

        const dirPath = path.join(planDir, entry)

        if (/concurrent_group/.test(logical)) {
            const subEntries = await readdir(dirPath).catch(() => [] as string[])
            for (const sub of subEntries) {
                const subDirPath = path.join(dirPath, sub)
                const subDesc = sub.replace(/_/g, " ")
                const outcome = await readStepOutcome(subDirPath)
                steps.push({
                    entry: sub,
                    dirPath: subDirPath,
                    timestamp: parseEntryTimestamp(entry),
                    stepNumber: stepMatch[1],
                    description: subDesc,
                    outcome,
                })
            }
        } else {
            const outcome = await readStepOutcome(dirPath)
            steps.push({
                entry,
                dirPath,
                timestamp: parseEntryTimestamp(entry),
                stepNumber: stepMatch[1],
                description: stepMatch[2].replace(/_/g, " "),
                outcome,
            })
        }
    }

    steps.sort((a, b) => parseInt(a.stepNumber) - parseInt(b.stepNumber))
    return steps
}

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
                if (entry.endsWith(".deleted")) continue
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
 *  4. Trailing `.deleted`
 */
function stripTaskNameDecorations(name: string): string {
    // 1. Strip leading dot
    let n = name.startsWith(".") ? name.slice(1) : name
    // 2. Strip timestamp prefix: YYYY-MM-DD_HH-mm-ss_
    n = n.replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/, "")
    // 3. Strip trailing .failed
    if (n.endsWith(".failed")) n = n.slice(0, -".failed".length)
    // 4. Strip trailing .deleted
    if (n.endsWith(".deleted")) n = n.slice(0, -".deleted".length)
    return n
}

/**
 * Find the plan directory across execute/, build/, and review/ locations.
 * Returns the first found path, or null.
 */
async function findPlanDir(worktree: string, planName: string): Promise<string | null> {
    const candidates = [
        path.join(worktree, ".autocode", "execute", planName),
        path.join(worktree, ".autocode", "build",   planName),
        path.join(worktree, ".autocode", "review",  planName),
    ]
    for (const candidate of candidates) {
        try { await readdir(candidate); return candidate } catch { /* try next */ }
    }
    return null
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

                    return successResponse(sid, toolName, {
                        instruction: "Orchestration completed. Call autocode_orchestrate_review to generate the review report.",
                        plan_name: args.plan_name,
                        review_path: reviewDir,
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

    // ─── tool: autocode_orchestrate_retry_task ──────────────────────────────

    /**
     * Reconnect to the session of a failed task and retry it, optionally with
     * a corrective instruction.  The session ID is parsed from the existing
     * `session.{id}.md` file in the task directory.
     *
     * On completion rewrites `session.{id}.md` and replaces `success.md` /
     * `failure.md` so the next `autocode_orchestrate_resume` call picks up the
     * new outcome correctly.
     */
    const autocode_orchestrate_retry_task: ToolDefinition = tool({
        description:
            "Reconnect to the session of a failed task and retry it. " +
            "Parses the session ID from the existing session.{id}.md file in the task directory. " +
            "Sends `instruction` to the session (defaults to 'retry' when omitted). " +
            "Rewrites session.{id}.md and success.md / failure.md with the new outcome. " +
            "Returns { success, outcome, summary }.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("The plan name"),
            task_name: tool.schema
                .string()
                .describe("Task name exactly as shown in progress (e.g. '01-create_model')"),
            instruction: tool.schema
                .string()
                .optional()
                .describe("Instruction to send to the session. Defaults to 'retry'. Provide corrective guidance to help the agent fix its failure."),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_retry_task"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const taskNameErr = validateNonEmpty(args.task_name, sid, toolName, "task_name")
            if (taskNameErr) return taskNameErr

            const dir = await resolveTaskDir(context.worktree, args.plan_name, args.task_name)
            if (!dir) {
                return retryResponse(sid, toolName, "task_name",
                    `match an existing task for plan '${args.plan_name}' — '${args.task_name}' was not found`)
            }

            const sessionId = await findSessionId(dir)
            if (!sessionId) {
                return abortResponse(toolName,
                    `No session file found for task '${args.task_name}' — the task may not have run yet. ` +
                    `Use autocode_orchestrate_resume to start it.`)
            }

            const instruction = args.instruction?.trim() || "retry"

            try {
                await client.session.prompt({
                    path: { id: sessionId },
                    body: {
                        agent: "execute",
                        parts: [{ type: "text", text: instruction }],
                    },
                    throwOnError: true,
                })

                const resp = await client.session.messages({
                    path: { id: sessionId },
                    throwOnError: true,
                })
                const messages = (resp.data ?? []) as MessageEntry[]

                const result = extractTaskResult(messages)

                // Read the original prompt for the session record (best-effort)
                const buildPrompt = await readFile(path.join(dir, "prompt.md"), "utf-8").catch(() => instruction)

                await writeOutcomeFiles(
                    dir,
                    sessionId,
                    formatSessionMarkdown(buildPrompt, messages),
                    result,
                )

                const assistant = messages.filter(m => m.info.role === "assistant")
                const summary = assistant.length > 0
                    ? assistant[assistant.length - 1].parts
                        .filter(p => p.type === "text")
                        .map(p => p.text ?? "")
                        .join("\n")
                        .slice(0, 500)
                    : "(no response)"

                return successResponse(sid, toolName, {
                    success: result.kind === "success",
                    outcome: result.kind,
                    summary,
                })
            } catch (err: any) {
                return abortResponse(toolName,
                    `retry session failed for task '${args.task_name}': ${err.message}`)
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
            "Provide task_name to read a specific task's prompt (e.g. '01-create_model'). " +
            "Omit task_name to read the next pending task's prompt.",
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
     * Auto-generates `review.md` by walking the plan directory and reading
     * `success.md`/`failure.md` from each task directory.
     */
    const autocode_orchestrate_review: ToolDefinition = tool({
        description:
            "Generate and write the review report (review.md) for a completed plan. " +
            "Walks every task directory in the plan, reads success.md or failure.md from each, " +
            "and produces a structured markdown report with a progress table and per-step details. " +
            "No agent input required — the report is generated automatically from the task outcome files. " +
            "Returns { review_path } on success or { error } on failure.",
        args: {
            plan_name: tool.schema
                .string()
                .describe("Plan name (as returned by autocode_build_plan)"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_review"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

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
                    sid, toolName, "plan_name",
                    `match an existing plan directory — '${args.plan_name}' was not found in review/, execute/, or build/`,
                )
            }

            try {
                const steps = await collectSteps(planDir)
                const markdown = buildReviewMarkdown(args.plan_name, steps)
                const reviewPath = path.join(planDir, "review.md")
                await writeFile(reviewPath, markdown, "utf-8")
                return successResponse(sid, toolName, { review_path: reviewPath })
            } catch (err: any) {
                return abortResponse(toolName, `failed to generate review for plan '${args.plan_name}': ${err.message}`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_list ────────────────────────────────────

    /**
     * List all plans available for orchestration in `.autocode/build/` and `.autocode/execute/`.
     *
     * Returns an array of unique plan directory names from both locations.
     * Each entry represents a plan that has been built or is currently being executed.
     */
    const autocode_orchestrate_list: ToolDefinition = tool({
        description:
            "List all plans available for orchestration in .autocode/build/ and .autocode/execute/. " +
            "Returns an array of plan names (directory names) that can be passed to " +
            "autocode_orchestrate_resume to start or resume execution.",
        args: {},
        async execute(_args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_list"
            const buildDir = path.join(context.worktree, ".autocode", "build")
            const executeDir = path.join(context.worktree, ".autocode", "execute")

            const getPlans = async (dir: string) => {
                try {
                    const entries = await readdir(dir, { withFileTypes: true })
                    return entries.filter(e => e.isDirectory()).map(e => e.name)
                } catch (err: any) {
                    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
                    throw err
                }
            }

            try {
                const [buildPlans, executePlans] = await Promise.all([
                    getPlans(buildDir),
                    getPlans(executeDir),
                ])
                const plans = Array.from(new Set([...buildPlans, ...executePlans])).sort()
                return successResponse(sid, toolName, { plans })
            } catch (err: any) {
                return abortResponse(toolName, `failed to list plans: ${err.message}`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_read_plan_purpose ───────────────────────

    const autocode_orchestrate_read_plan_purpose: ToolDefinition = tool({
        description:
            "Read the purpose of a plan from plan.md. " +
            "Returns the Background, Problem Statement, and Solution Overview sections only — " +
            "a concise summary of why the plan exists and what it aims to achieve.",
        args: {
            plan_name: tool.schema.string().describe("The plan name"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_read_plan_purpose"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const candidates = [
                path.join(context.worktree, ".autocode", "build",   args.plan_name, "plan.md"),
                path.join(context.worktree, ".autocode", "execute", args.plan_name, "plan.md"),
                path.join(context.worktree, ".autocode", "review",  args.plan_name, "plan.md"),
            ]
            let content: string | null = null
            for (const p of candidates) {
                try { content = await readFile(p, "utf-8"); break } catch { /* try next */ }
            }
            if (content === null) {
                return abortResponse(toolName, `plan.md not found for plan '${args.plan_name}'`)
            }

            // Extract Background, Problem Statement, Solution Overview sections
            const sections: string[] = []
            const sectionNames = ["Background", "Problem Statement", "Solution Overview"]
            for (const name of sectionNames) {
                // Match ## {name} up to the next ## heading or end of file
                const re = new RegExp(`## ${name}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`)
                const m = content.match(re)
                if (m) sections.push(`## ${name}\n${m[1].trim()}`)
            }

            if (sections.length === 0) {
                return abortResponse(toolName, `No purpose sections found in plan.md for '${args.plan_name}'`)
            }

            return successResponse(sid, toolName, sections.join("\n\n"))
        },
    })

    // ─── tool: autocode_orchestrate_read_progress ───────────────────────────

    const autocode_orchestrate_read_progress: ToolDefinition = tool({
        description:
            "Read the current progress of a plan as a markdown table. " +
            "Shows each step with its description and status (Success / Failure / Incomplete). " +
            "Deleted steps are excluded. Does not include timestamps.",
        args: {
            plan_name: tool.schema.string().describe("The plan name"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_read_progress"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const candidates = [
                path.join(context.worktree, ".autocode", "review",  args.plan_name),
                path.join(context.worktree, ".autocode", "execute", args.plan_name),
                path.join(context.worktree, ".autocode", "build",   args.plan_name),
            ]
            let planDir: string | null = null
            for (const candidate of candidates) {
                try { await readdir(candidate); planDir = candidate; break } catch { /* try next */ }
            }
            if (!planDir) {
                return retryResponse(sid, toolName, "plan_name",
                    `match an existing plan directory — '${args.plan_name}' was not found`)
            }

            const steps = await collectSteps(planDir)
            const lines: string[] = []
            lines.push("| Step | Description | Status |")
            lines.push("|------|-------------|--------|")
            for (const s of steps) {
                const status =
                    s.outcome.kind === "success" ? "Success" :
                    s.outcome.kind === "failure" ? "Failure" :
                    "Incomplete"
                lines.push(`| ${s.stepNumber} | ${s.description} | ${status} |`)
            }
            return successResponse(sid, toolName, lines.join("\n"))
        },
    })

    // ─── tool: autocode_orchestrate_read_step_success ───────────────────────

    const autocode_orchestrate_read_step_success: ToolDefinition = tool({
        description:
            "Read the success.md file for a completed step. " +
            "Returns the success response written by the execute agent for that step.",
        args: {
            plan_name: tool.schema.string().describe("The plan name"),
            task_name: tool.schema.string().describe("Task name (e.g. '01-create_model')"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_read_step_success"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr
            const taskNameErr = validateNonEmpty(args.task_name, sid, toolName, "task_name")
            if (taskNameErr) return taskNameErr

            const dir = await resolveTaskDir(context.worktree, args.plan_name, args.task_name)
            if (!dir) {
                return retryResponse(sid, toolName, "task_name",
                    `match an existing task for plan '${args.plan_name}' — '${args.task_name}' was not found`)
            }
            try {
                const content = await readFile(path.join(dir, "success.md"), "utf-8")
                return successResponse(sid, toolName, content)
            } catch {
                return abortResponse(toolName, `success.md not found for task '${args.task_name}' — the step may not have completed successfully`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_read_step_failure ───────────────────────

    const autocode_orchestrate_read_step_failure: ToolDefinition = tool({
        description:
            "Read the failure.md file for a failed step. " +
            "Returns the failure response written by the execute agent for that step.",
        args: {
            plan_name: tool.schema.string().describe("The plan name"),
            task_name: tool.schema.string().describe("Task name (e.g. '01-create_model')"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_read_step_failure"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr
            const taskNameErr = validateNonEmpty(args.task_name, sid, toolName, "task_name")
            if (taskNameErr) return taskNameErr

            const dir = await resolveTaskDir(context.worktree, args.plan_name, args.task_name)
            if (!dir) {
                return retryResponse(sid, toolName, "task_name",
                    `match an existing task for plan '${args.plan_name}' — '${args.task_name}' was not found`)
            }
            try {
                const content = await readFile(path.join(dir, "failure.md"), "utf-8")
                return successResponse(sid, toolName, content)
            } catch {
                return abortResponse(toolName, `failure.md not found for task '${args.task_name}' — the step may not have failed or may not have run yet`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_insert_step ─────────────────────────────

    const autocode_orchestrate_insert_step: ToolDefinition = tool({
        description:
            "Insert a new step into the plan at a given index, shifting all subsequent steps up by 1. " +
            "For each shifted step, outcome files (success.md, failure.md, session.*.md) are hidden " +
            "by prefixing with .{timestamp}. so the step will re-run on next resume. " +
            "If step_index is omitted, inserts before the current pending step.",
        args: {
            plan_name: tool.schema.string().describe("The plan name"),
            step_name: tool.schema.string().describe("Logical name for the new step (e.g. 'add_validation'). Will become '{index:02}-{step_name}'."),
            prompt: tool.schema.string().describe("Content to write to the new step's prompt.md"),
            step_index: tool.schema.number().int().min(1).optional()
                .describe("1-based index to insert at. Omit to insert before the current pending step."),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_insert_step"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr
            const stepNameErr = validateNonEmpty(args.step_name, sid, toolName, "step_name")
            if (stepNameErr) return stepNameErr
            const promptErr = validateNonEmpty(args.prompt, sid, toolName, "prompt")
            if (promptErr) return promptErr

            const planDir = await findPlanDir(context.worktree, args.plan_name)
            if (!planDir) {
                return retryResponse(sid, toolName, "plan_name",
                    `match an existing plan directory — '${args.plan_name}' was not found`)
            }

            const entries = await readdir(planDir).catch(() => [] as string[])

            // Collect all active step entries (not deleted, parse their index)
            type StepEntry = { entry: string; index: number }
            const stepEntries: StepEntry[] = []
            for (const entry of entries) {
                if (entry.endsWith(".deleted")) continue
                const logical = stripTaskNameDecorations(entry)
                if (logical.endsWith(".deleted")) continue
                const m = logical.match(/^(\d{2})-/)
                if (!m) continue
                stepEntries.push({ entry, index: parseInt(m[1], 10) })
            }
            stepEntries.sort((a, b) => a.index - b.index)

            // Determine insert index
            let insertIndex: number
            if (args.step_index !== undefined) {
                insertIndex = args.step_index
            } else {
                // Find lowest pending step (entry starts with exactly XX-)
                const pending = entries.filter(e => /^\d{2}-/.test(e))
                if (pending.length > 0) {
                    pending.sort()
                    const m = pending[0].match(/^(\d+)/)
                    insertIndex = m ? parseInt(m[1], 10) : (stepEntries.length + 1)
                } else {
                    insertIndex = stepEntries.length + 1
                }
            }

            // Check overflow
            const maxIndex = stepEntries.length + 1
            if (maxIndex > 99) {
                return abortResponse(toolName, `Cannot insert step: plan already has ${stepEntries.length} steps (max 99)`)
            }

            const ts = makeTimestamp()

            // Shift all steps with index >= insertIndex
            // Process in reverse order to avoid name collisions
            const toShift = stepEntries.filter(s => s.index >= insertIndex).reverse()
            let stepsShifted = 0
            for (const { entry, index } of toShift) {
                const newIndex = index + 1
                if (newIndex > 99) {
                    return abortResponse(toolName, `Cannot shift step ${index} to ${newIndex}: exceeds maximum index 99`)
                }
                const newIndexStr = String(newIndex).padStart(2, "0")
                const oldIndexStr = String(index).padStart(2, "0")

                // Rebuild the entry name with the new index
                // The index appears in the logical name portion: replace oldIndexStr- with newIndexStr-
                // We need to find where the logical name starts in the entry
                let newEntry = entry
                // Strip leading dot if present
                const hasDot = entry.startsWith(".")
                const stripped = hasDot ? entry.slice(1) : entry
                // Strip timestamp prefix if present
                const tsMatch = stripped.match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_)(.+)$/)
                if (tsMatch) {
                    const tsPrefix = tsMatch[1]
                    const rest = tsMatch[2]
                    // rest starts with oldIndexStr-
                    const newRest = newIndexStr + rest.slice(oldIndexStr.length)
                    newEntry = (hasDot ? "." : "") + tsPrefix + newRest
                } else {
                    // No timestamp prefix — entry is just the logical name (possibly with .failed)
                    const newRest = newIndexStr + stripped.slice(oldIndexStr.length)
                    newEntry = (hasDot ? "." : "") + newRest
                }

                const oldPath = path.join(planDir, entry)
                const newPath = path.join(planDir, newEntry)
                await rename(oldPath, newPath)

                // Hide outcome files inside the shifted directory
                const dirFiles = await readdir(newPath).catch(() => [] as string[])
                for (const f of dirFiles) {
                    if (f === "success.md" || f === "failure.md" || /^session\..+\.md$/.test(f)) {
                        await rename(
                            path.join(newPath, f),
                            path.join(newPath, `.${ts}.${f}`),
                        ).catch(() => {})
                    }
                }
                stepsShifted++
            }

            // Create the new step directory and write prompt.md
            const newStepName = `${String(insertIndex).padStart(2, "0")}-${args.step_name}`
            const newStepDir = path.join(planDir, newStepName)
            await mkdir(newStepDir, { recursive: true })
            await writeFile(path.join(newStepDir, "prompt.md"), args.prompt, "utf-8")

            return successResponse(sid, toolName, {
                inserted_step: newStepName,
                steps_shifted: stepsShifted,
            })
        },
    })

    // ─── tool: autocode_orchestrate_move_step ───────────────────────────────

    const autocode_orchestrate_move_step: ToolDefinition = tool({
        description:
            "Move a step to a new position in the plan, shifting other steps to accommodate. " +
            "Outcome files (success.md, failure.md, session.*.md) in the moved step and all " +
            "shifted steps are hidden so they will re-run on next resume.",
        args: {
            plan_name: tool.schema.string().describe("The plan name"),
            task_name: tool.schema.string().describe("Task name to move (e.g. '01-create_model')"),
            new_index: tool.schema.number().int().min(1)
                .describe("1-based target index for the step"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_move_step"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr
            const taskNameErr = validateNonEmpty(args.task_name, sid, toolName, "task_name")
            if (taskNameErr) return taskNameErr

            const planDir = await findPlanDir(context.worktree, args.plan_name)
            if (!planDir) {
                return retryResponse(sid, toolName, "plan_name",
                    `match an existing plan directory — '${args.plan_name}' was not found`)
            }

            const entries = await readdir(planDir).catch(() => [] as string[])

            type StepEntry = { entry: string; index: number; logical: string }
            const stepEntries: StepEntry[] = []
            for (const entry of entries) {
                if (entry.endsWith(".deleted")) continue
                const logical = stripTaskNameDecorations(entry)
                if (logical.endsWith(".deleted")) continue
                const m = logical.match(/^(\d{2})-/)
                if (!m) continue
                stepEntries.push({ entry, index: parseInt(m[1], 10), logical })
            }
            stepEntries.sort((a, b) => a.index - b.index)

            // Find the step to move
            const target = stepEntries.find(s => s.logical === args.task_name)
            if (!target) {
                return retryResponse(sid, toolName, "task_name",
                    `match an existing task for plan '${args.plan_name}' — '${args.task_name}' was not found`)
            }

            const oldIndex = target.index
            const newIndex = Math.min(args.new_index, stepEntries.length)

            if (oldIndex === newIndex) {
                return successResponse(sid, toolName, { message: "Step is already at the requested index", steps_shifted: 0 })
            }

            const ts = makeTimestamp()
            const localPlanDir = planDir

            // Helper: rename a step entry to a new index, hide its outcome files
            async function renameStep(entry: string, fromIndex: number, toIndex: number): Promise<void> {
                const fromIndexStr = String(fromIndex).padStart(2, "0")
                const toIndexStr = String(toIndex).padStart(2, "0")
                const hasDot = entry.startsWith(".")
                const stripped = hasDot ? entry.slice(1) : entry
                const tsMatch = stripped.match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_)(.+)$/)
                let newEntry: string
                if (tsMatch) {
                    const newRest = toIndexStr + tsMatch[2].slice(fromIndexStr.length)
                    newEntry = (hasDot ? "." : "") + tsMatch[1] + newRest
                } else {
                    const newRest = toIndexStr + stripped.slice(fromIndexStr.length)
                    newEntry = (hasDot ? "." : "") + newRest
                }
                const oldPath = path.join(localPlanDir, entry)
                const newPath = path.join(localPlanDir, newEntry)
                await rename(oldPath, newPath)
                // Hide outcome files
                const dirFiles = await readdir(newPath).catch(() => [] as string[])
                for (const f of dirFiles) {
                    if (f === "success.md" || f === "failure.md" || /^session\..+\.md$/.test(f)) {
                        await rename(
                            path.join(newPath, f),
                            path.join(newPath, `.${ts}.${f}`),
                        ).catch(() => {})
                    }
                }
            }

            // Temporarily rename the target step to a placeholder to avoid conflicts
            const placeholderName = `.moving_${ts}_${target.entry}`
            await rename(path.join(localPlanDir, target.entry), path.join(localPlanDir, placeholderName))

            let stepsShifted = 0
            if (newIndex > oldIndex) {
                // Moving down: shift steps between (oldIndex+1..newIndex) up by -1
                const toShift = stepEntries.filter(s => s.index > oldIndex && s.index <= newIndex)
                for (const s of toShift) {
                    await renameStep(s.entry, s.index, s.index - 1)
                    stepsShifted++
                }
            } else {
                // Moving up: shift steps between (newIndex..oldIndex-1) down by +1
                const toShift = stepEntries.filter(s => s.index >= newIndex && s.index < oldIndex).reverse()
                for (const s of toShift) {
                    await renameStep(s.entry, s.index, s.index + 1)
                    stepsShifted++
                }
            }

            // Rename the placeholder to the new index
            const newIndexStr = String(newIndex).padStart(2, "0")
            const oldIndexStr = String(oldIndex).padStart(2, "0")
            const hasDot = target.entry.startsWith(".")
            const stripped = hasDot ? target.entry.slice(1) : target.entry
            const tsMatch = stripped.match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_)(.+)$/)
            let finalEntry: string
            if (tsMatch) {
                const newRest = newIndexStr + tsMatch[2].slice(oldIndexStr.length)
                finalEntry = (hasDot ? "." : "") + tsMatch[1] + newRest
            } else {
                const newRest = newIndexStr + stripped.slice(oldIndexStr.length)
                finalEntry = (hasDot ? "." : "") + newRest
            }
            const finalPath = path.join(localPlanDir, finalEntry)
            await rename(path.join(localPlanDir, placeholderName), finalPath)
            // Hide outcome files in the moved step
            const movedFiles = await readdir(finalPath).catch(() => [] as string[])
            for (const f of movedFiles) {
                if (f === "success.md" || f === "failure.md" || /^session\..+\.md$/.test(f)) {
                    await rename(
                        path.join(finalPath, f),
                        path.join(finalPath, `.${ts}.${f}`),
                    ).catch(() => {})
                }
            }

            return successResponse(sid, toolName, {
                moved_step: finalEntry,
                from_index: oldIndex,
                to_index: newIndex,
                steps_shifted: stepsShifted,
            })
        },
    })

    // ─── tool: autocode_orchestrate_delete_step ─────────────────────────────

    const autocode_orchestrate_delete_step: ToolDefinition = tool({
        description:
            "Soft-delete a step by renaming its directory to a .deleted suffix. " +
            "The directory is preserved on disk for auditing but is excluded from all " +
            "orchestration, reporting, and review operations. " +
            "Other steps are NOT renumbered — gaps in the sequence are allowed.",
        args: {
            plan_name: tool.schema.string().describe("The plan name"),
            task_name: tool.schema.string().describe("Task name to delete (e.g. '01-create_model')"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_delete_step"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr
            const taskNameErr = validateNonEmpty(args.task_name, sid, toolName, "task_name")
            if (taskNameErr) return taskNameErr

            const planDir = await findPlanDir(context.worktree, args.plan_name)
            if (!planDir) {
                return retryResponse(sid, toolName, "plan_name",
                    `match an existing plan directory — '${args.plan_name}' was not found`)
            }

            const entries = await readdir(planDir).catch(() => [] as string[])
            let foundEntry: string | null = null
            for (const entry of entries) {
                if (entry.endsWith(".deleted")) continue
                const logical = stripTaskNameDecorations(entry)
                if (logical.endsWith(".deleted")) continue
                if (logical === args.task_name) {
                    foundEntry = entry
                    break
                }
            }

            if (!foundEntry) {
                return retryResponse(sid, toolName, "task_name",
                    `match an existing task for plan '${args.plan_name}' — '${args.task_name}' was not found`)
            }

            const ts = makeTimestamp()
            const deletedName = `.${ts}_${foundEntry}.deleted`
            await rename(path.join(planDir, foundEntry), path.join(planDir, deletedName))

            return successResponse(sid, toolName, {
                deleted_step: args.task_name,
                archived_as: deletedName,
            })
        },
    })

    // ─── exports ─────────────────────────────────────────────────────────────

    return {
        autocode_orchestrate_list,
        autocode_orchestrate_resume,
        autocode_orchestrate_fix_task,
        autocode_orchestrate_retry_task,
        autocode_orchestrate_review,
        autocode_orchestrate_read_plan,
        autocode_orchestrate_read_plan_purpose,
        autocode_orchestrate_read_progress,
        autocode_orchestrate_read_task_prompt,
        autocode_orchestrate_read_step_success,
        autocode_orchestrate_read_step_failure,
        autocode_orchestrate_insert_step,
        autocode_orchestrate_move_step,
        autocode_orchestrate_delete_step,
    }
}
