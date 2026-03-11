import { readdir, readFile, stat, unlink, writeFile } from "fs/promises"
import path from "path"

// ─── types ───────────────────────────────────────────────────────────────────

export type MessageEntry = {
    info: { role: string }
    parts: Array<{ type: string; text?: string }>
}

export type FailureType = "task_session" | "test_session" | "test_verification" | "tool_error" | "task_failure" | "agent_failure"

export type TaskInfo = {
    entry: string
    dirPath: string
    timestamp: string
    taskNumber: string
    description: string
    outcome:
        | { kind: "success"; content: string; completedAt: string }
        | { kind: "failure"; content: string }
        | { kind: "incomplete" }
}

export type TaskFailure = {
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
     *  - agent_failure     — agent session returned a failure response
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
    /** The agent name that produced the failure (set for agent_failure type) */
    agentName?: string
}

// ─── pure helpers (no IO) ────────────────────────────────────────────────────

/**
 * Format spawned session messages into a readable markdown document.
 */
export function formatSessionMarkdown(prompt: string, messages: MessageEntry[]): string {
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
 * Extract the last assistant message as the task result.
 * Returns { kind: "success", content } with the full last assistant message text.
 * Returns { kind: "failure", content: "The assistant did not respond." } when no assistant messages exist.
 *
 * Note: Agents no longer emit <success>/<failure> XML tags. The orchestrate agent
 * reads the natural response and decides success/failure from context.
 */
export function extractTaskResult(
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
        .trim()

    return { kind: "success", content: text }
}

/**
 * Generate a timestamp string in `YYYY-MM-DD_HH-mm-ss` format (local time).
 */
export function makeTimestamp(): string {
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
export function parseEntryTimestamp(entry: string): string {
    const s = entry.startsWith(".") ? entry.slice(1) : entry
    const m = s.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_/)
    if (!m) return "—"
    return `${m[1]} ${m[2]}:${m[3]}:${m[4]}`
}

/**
 * Build the markdown review report from a list of step infos.
 */
export function buildReviewMarkdown(planName: string, tasks: TaskInfo[]): string {
    const lines: string[] = []
    lines.push(`# ${planName}`, "")
    lines.push("## Progress", "")
    lines.push("| Timestamp | Task | Description | Completed |")
    lines.push("|-----------|------|-------------|-----------|")
    for (const s of tasks) {
        const completed =
            s.outcome.kind === "success" ? s.outcome.completedAt :
            s.outcome.kind === "failure" ? "Failure" :
            "Incomplete"
        lines.push(`| ${s.timestamp} | ${s.taskNumber} | ${s.description} | ${completed} |`)
    }
    lines.push("")
    lines.push("## Details", "")
    for (const s of tasks) {
        if (s.outcome.kind === "incomplete") continue
        lines.push(`### ${s.taskNumber} — ${s.description}`, "")
        lines.push(s.outcome.content, "")
    }
    return lines.join("\n")
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
export function stripTaskNameDecorations(name: string): string {
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

// ─── async helpers ───────────────────────────────────────────────────────────

/**
 * Return the mtime of a file as a `YYYY-MM-DD HH:mm:ss` string.
 */
export async function fileMtime(filePath: string): Promise<string> {
    try {
        const s = await stat(filePath)
        const d = s.mtime
        const pad = (n: number) => String(n).padStart(2, "0")
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    } catch {
        return "—"
    }
}

export async function readTaskOutcome(dirPath: string): Promise<TaskInfo["outcome"]> {
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
 * Walk all task entries in a plan directory and collect TaskInfo records.
 * Handles pending, in-flight, succeeded, and failed task states.
 * Recurses into concurrent groups.
 */
export async function collectTasks(planDir: string): Promise<TaskInfo[]> {
    const tasks: TaskInfo[] = []
    const entries = await readdir(planDir).catch(() => [] as string[])

    for (const entry of entries) {
        // Skip deleted tasks
        if (entry.endsWith(".deleted")) continue
        const logical = stripTaskNameDecorations(entry)
        if (logical.endsWith(".deleted")) continue
        const taskMatch = logical.match(/^(\d{2})-(.+)$/)
        if (!taskMatch) continue

        const dirPath = path.join(planDir, entry)

        if (/concurrent_group/i.test(logical)) {
            const subEntries = await readdir(dirPath).catch(() => [] as string[])
            for (const sub of subEntries) {
                const subDirPath = path.join(dirPath, sub)
                const subDesc = sub.replace(/_/g, " ")
                const outcome = await readTaskOutcome(subDirPath)
                tasks.push({
                    entry: sub,
                    dirPath: subDirPath,
                    timestamp: parseEntryTimestamp(entry),
                    taskNumber: taskMatch[1],
                    description: subDesc,
                    outcome,
                })
            }
        } else {
            const outcome = await readTaskOutcome(dirPath)
            tasks.push({
                entry,
                dirPath,
                timestamp: parseEntryTimestamp(entry),
                taskNumber: taskMatch[1],
                description: taskMatch[2].replace(/_/g, " "),
                outcome,
            })
        }
    }

    tasks.sort((a, b) => parseInt(a.taskNumber) - parseInt(b.taskNumber))
    return tasks
}

/**
 * Scan a directory for an existing session file.
 * If agentName is provided, looks for `{agentName}.session.{id}.md`.
 * Otherwise falls back to the legacy `session.{id}.md` pattern.
 * Returns the session ID string extracted from the filename, or null.
 */
export async function findSessionId(dir: string, agentName?: string): Promise<string | null> {
    const entries = await readdir(dir).catch(() => [] as string[])
    if (agentName) {
        // Look for {agentName}.session.{id}.md
        const prefix = `${agentName}.session.`
        const match = entries.find(e => e.startsWith(prefix) && e.endsWith(".md"))
        if (!match) return null
        return match.slice(prefix.length, -".md".length)
    }
    // Legacy: match session.{id}.md but NOT session.ok.* or session.fail.*
    const match = entries.find(e => /^session\.(?!ok\.|fail\.)(.+)\.md$/i.test(e))
    if (!match) return null
    const m = match.match(/^session\.(.+)\.md$/i)
    return m ? m[1] : null
}

/**
 * Write success.md or failure.md after removing any stale counterpart.
 * Always writes session.{sessionId}.md with the full session content.
 */
export async function writeOutcomeFiles(
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
export async function findNextGroup(planDir: string): Promise<string | null> {
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
 * The plan may live in `.autocode/build/`, `.autocode/failed/`, or
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
export async function resolveTaskDir(
    worktree: string,
    planName: string,
    taskName?: string,
): Promise<string | null> {
    const bases = [
        path.join(worktree, ".autocode", "build",   planName),
        path.join(worktree, ".autocode", "failed",  planName),
        path.join(worktree, ".autocode", "review",  planName),
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
                if (/concurrent_group/i.test(logical)) {
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
 * Find the plan directory across build/, failed/, and review/ locations.
 * Returns the first found path, or null.
 */
export async function findPlanDir(worktree: string, planName: string): Promise<string | null> {
    const candidates = [
        path.join(worktree, ".autocode", "build",   planName),
        path.join(worktree, ".autocode", "failed",  planName),
        path.join(worktree, ".autocode", "review",  planName),
    ]
    for (const candidate of candidates) {
        try { await readdir(candidate); return candidate } catch { /* try next */ }
    }
    return null
}
