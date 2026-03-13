import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import {
    formatSessionMarkdown,
    extractTaskResult,
    makeTimestamp,
    parseEntryTimestamp,
    buildReviewMarkdown,
    stripTaskNameDecorations,
    fileMtime,
    readTaskOutcome,
    findSessionId,
    writeOutcomeFiles,
    findNextGroup,
    collectTasks,
    findPlanDir,
    resolveTaskDir,
    type MessageEntry,
    type TaskInfo,
} from "./tasks"

// ─── pure helpers ────────────────────────────────────────────────────────────

describe("formatSessionMarkdown", () => {
    test("starts with # Session Record", () => {
        const result = formatSessionMarkdown("my prompt", [])
        expect(result.startsWith("# Session Record")).toBe(true)
    })

    test("includes prompt under ## Prompt", () => {
        const result = formatSessionMarkdown("my prompt", [])
        expect(result).toContain("## Prompt")
        expect(result).toContain("my prompt")
    })

    test("includes ### User and ### Assistant role labels", () => {
        const messages: MessageEntry[] = [
            { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
            { info: { role: "assistant" }, parts: [{ type: "text", text: "world" }] },
        ]
        const result = formatSessionMarkdown("p", messages)
        expect(result).toContain("### User")
        expect(result).toContain("### Assistant")
        expect(result).toContain("hello")
        expect(result).toContain("world")
    })

    test("handles empty messages array (no session entries)", () => {
        const result = formatSessionMarkdown("prompt", [])
        expect(result).toContain("## Session")
        expect(result).not.toContain("### User")
        expect(result).not.toContain("### Assistant")
    })

    test("handles reasoning part type (includes its text)", () => {
        const messages: MessageEntry[] = [
            { info: { role: "assistant" }, parts: [{ type: "reasoning", text: "thinking..." }] },
        ]
        const result = formatSessionMarkdown("p", messages)
        expect(result).toContain("thinking...")
    })

    test("skips parts with no text (e.g. type: tool_use)", () => {
        const messages: MessageEntry[] = [
            { info: { role: "assistant" }, parts: [{ type: "tool_use" }, { type: "text", text: "done" }] },
        ]
        const result = formatSessionMarkdown("p", messages)
        expect(result).toContain("done")
        // tool_use part has no text so nothing extra should appear
        expect(result.indexOf("tool_use")).toBe(-1)
    })
})

describe("extractTaskResult", () => {
    test("returns failure when messages array is empty", () => {
        const result = extractTaskResult([])
        expect(result).toEqual({ kind: "failure", content: "The assistant did not respond." })
    })

    test("returns success with full text of last assistant message", () => {
        const messages: MessageEntry[] = [
            { info: { role: "assistant" }, parts: [{ type: "text", text: "Task completed successfully." }] },
        ]
        const result = extractTaskResult(messages)
        expect(result).toEqual({ kind: "success", content: "Task completed successfully." })
    })

    test("returns success even when response mentions errors (orchestrate agent decides)", () => {
        const messages: MessageEntry[] = [
            { info: { role: "assistant" }, parts: [{ type: "text", text: "There was an error connecting to the database." }] },
        ]
        const result = extractTaskResult(messages)
        expect(result.kind).toBe("success")
        expect(result.content).toBe("There was an error connecting to the database.")
    })

    test("trims whitespace from response", () => {
        const messages: MessageEntry[] = [
            { info: { role: "assistant" }, parts: [{ type: "text", text: "  done  " }] },
        ]
        const result = extractTaskResult(messages)
        expect(result).toEqual({ kind: "success", content: "done" })
    })

    test("uses only the last assistant message (ignores earlier ones)", () => {
        const messages: MessageEntry[] = [
            { info: { role: "assistant" }, parts: [{ type: "text", text: "first attempt failed" }] },
            { info: { role: "user" }, parts: [{ type: "text", text: "try again" }] },
            { info: { role: "assistant" }, parts: [{ type: "text", text: "second attempt succeeded" }] },
        ]
        const result = extractTaskResult(messages)
        expect(result).toEqual({ kind: "success", content: "second attempt succeeded" })
    })

    test("concatenates multiple text parts from last assistant message", () => {
        const messages: MessageEntry[] = [
            {
                info: { role: "assistant" },
                parts: [
                    { type: "text", text: "part one" },
                    { type: "text", text: "part two" },
                ],
            },
        ]
        const result = extractTaskResult(messages)
        expect(result.kind).toBe("success")
        expect(result.content).toContain("part one")
        expect(result.content).toContain("part two")
    })

    test("returns failure when no assistant messages exist (only user messages)", () => {
        const messages: MessageEntry[] = [
            { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
        ]
        const result = extractTaskResult(messages)
        expect(result).toEqual({ kind: "failure", content: "The assistant did not respond." })
    })
})

describe("makeTimestamp", () => {
    test("returns string matching YYYY-MM-DD_HH-mm-ss format", () => {
        const ts = makeTimestamp()
        expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/)
    })
})

describe("parseEntryTimestamp", () => {
    test("always returns — (stub)", () => {
        expect(parseEntryTimestamp("01-my-task")).toBe("—")
    })

    test("returns — for timestamp-prefixed entries", () => {
        expect(parseEntryTimestamp("2024-03-15_10-30-45_01-my-task")).toBe("—")
    })

    test("returns — for dot-prefixed entries", () => {
        expect(parseEntryTimestamp(".2024-03-15_10-30-45_01-my-task")).toBe("—")
    })
})

describe("buildReviewMarkdown", () => {
    const baseTask = (overrides: Partial<TaskInfo> = {}): TaskInfo => ({
        entry: "01-my-task",
        dirPath: "/tmp/plan/01-my-task",
        timestamp: "2024-03-15 10:30:45",
        taskNumber: "01",
        description: "my task",
        outcome: { kind: "incomplete" },
        ...overrides,
    })

    test("starts with # {planName}", () => {
        const result = buildReviewMarkdown("my-plan", [])
        expect(result.startsWith("# my-plan")).toBe(true)
    })

    test("contains markdown table header", () => {
        const result = buildReviewMarkdown("plan", [])
        expect(result).toContain("| Timestamp | Task | Description | Completed |")
    })

    test("shows Failure for failed tasks in Completed column", () => {
        const step = baseTask({ outcome: { kind: "failure", content: "it broke" } })
        const result = buildReviewMarkdown("plan", [step])
        expect(result).toContain("| Failure |")
    })

    test("shows Incomplete for incomplete tasks", () => {
        const step = baseTask({ outcome: { kind: "incomplete" } })
        const result = buildReviewMarkdown("plan", [step])
        expect(result).toContain("| Incomplete |")
    })

    test("shows completedAt value for successful tasks", () => {
        const step = baseTask({ outcome: { kind: "success", content: "ok", completedAt: "2024-03-15 11:00:00" } })
        const result = buildReviewMarkdown("plan", [step])
        expect(result).toContain("2024-03-15 11:00:00")
    })

    test("includes ## Details section with content for success/failure tasks", () => {
        const steps = [
            baseTask({ taskNumber: "01", outcome: { kind: "success", content: "success content", completedAt: "t" } }),
            baseTask({ taskNumber: "02", outcome: { kind: "failure", content: "failure content" } }),
        ]
        const result = buildReviewMarkdown("plan", steps)
        expect(result).toContain("## Details")
        expect(result).toContain("success content")
        expect(result).toContain("failure content")
    })

    test("skips incomplete tasks in the Details section", () => {
        const step = baseTask({ description: "pending work", outcome: { kind: "incomplete" } })
        const result = buildReviewMarkdown("plan", [step])
        expect(result).toContain("## Details")
        // The description appears in the table but not as a Details heading
        const detailsIdx = result.indexOf("## Details")
        const afterDetails = result.slice(detailsIdx)
        expect(afterDetails).not.toContain("### 01")
    })
})

describe("stripTaskNameDecorations", () => {
    test("strips leading dot", () => {
        expect(stripTaskNameDecorations(".01-my-task")).toBe("01-my-task")
    })

    test("does not strip timestamp prefix (timestamps are no longer stripped)", () => {
        expect(stripTaskNameDecorations("2024-03-15_10-30-45_01-my-task")).toBe("2024-03-15_10-30-45_01-my-task")
    })

    test("strips -failed suffix", () => {
        expect(stripTaskNameDecorations("01-my-task-failed")).toBe("01-my-task")
    })

    test("does not strip .failed suffix (only -failed is stripped)", () => {
        expect(stripTaskNameDecorations("01-my-task.failed")).toBe("01-my-task.failed")
    })

    test("strips .deleted suffix", () => {
        expect(stripTaskNameDecorations("01-my-task.deleted")).toBe("01-my-task")
    })

    test("strips leading dot and -failed suffix combined", () => {
        expect(stripTaskNameDecorations(".01-my-task-failed")).toBe("01-my-task")
    })

    test("strips leading dot and .deleted suffix combined", () => {
        expect(stripTaskNameDecorations(".01-my-task.deleted")).toBe("01-my-task")
    })

    test("leaves plain names unchanged", () => {
        expect(stripTaskNameDecorations("01-my-task")).toBe("01-my-task")
    })
})

// ─── async helpers ────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "tasks-test-"))
})

afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
})

describe("fileMtime", () => {
    test("returns formatted timestamp for existing file", async () => {
        const file = path.join(tmpDir, "test.md")
        await writeFile(file, "content")
        const result = await fileMtime(file)
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    })

    test("returns — for non-existent file", async () => {
        const result = await fileMtime(path.join(tmpDir, "nonexistent.md"))
        expect(result).toBe("—")
    })
})

describe("readTaskOutcome", () => {
    test("returns incomplete when neither success.md nor failure.md exists", async () => {
        const dir = path.join(tmpDir, "task")
        await mkdir(dir)
        const result = await readTaskOutcome(dir)
        expect(result).toEqual({ kind: "incomplete" })
    })

    test("returns success when success.md exists", async () => {
        const dir = path.join(tmpDir, "task")
        await mkdir(dir)
        await writeFile(path.join(dir, "success.md"), "it worked")
        const result = await readTaskOutcome(dir)
        expect(result.kind).toBe("success")
        if (result.kind === "success") {
            expect(result.content).toBe("it worked")
            expect(result.completedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
        }
    })

    test("returns failure when failure.md exists", async () => {
        const dir = path.join(tmpDir, "task")
        await mkdir(dir)
        await writeFile(path.join(dir, "failure.md"), "it failed")
        const result = await readTaskOutcome(dir)
        expect(result).toEqual({ kind: "failure", content: "it failed" })
    })

    test("prefers success.md when both exist", async () => {
        const dir = path.join(tmpDir, "task")
        await mkdir(dir)
        await writeFile(path.join(dir, "success.md"), "success wins")
        await writeFile(path.join(dir, "failure.md"), "failure loses")
        const result = await readTaskOutcome(dir)
        expect(result.kind).toBe("success")
    })
})

describe("findSessionId", () => {
    test("returns null when directory is empty", async () => {
        const result = await findSessionId(tmpDir)
        expect(result).toBeNull()
    })

    test("returns session ID from {agentName}.session.{id}.md", async () => {
        await writeFile(path.join(tmpDir, "code.session.abc123.md"), "")
        const result = await findSessionId(tmpDir, "code")
        expect(result).toBe("abc123")
    })

    test("returns null when looking for agentName but only other agent session exists", async () => {
        await writeFile(path.join(tmpDir, "code.session.abc123.md"), "")
        const result = await findSessionId(tmpDir, "test")
        expect(result).toBeNull()
    })

    test("returns session ID from legacy session.{id}.md when no agentName given", async () => {
        await writeFile(path.join(tmpDir, "session.abc123.md"), "")
        const result = await findSessionId(tmpDir)
        expect(result).toBe("abc123")
    })

    test("returns null for session.ok.something.md (legacy exclusion pattern)", async () => {
        await writeFile(path.join(tmpDir, "session.ok.something.md"), "")
        const result = await findSessionId(tmpDir)
        expect(result).toBeNull()
    })
})

describe("writeOutcomeFiles", () => {
    test("writes session.{sessionId}.md with given content", async () => {
        await writeOutcomeFiles(tmpDir, "sid1", "session content", { kind: "success", content: "ok" })
        const file = path.join(tmpDir, "session.sid1.md")
        const content = await Bun.file(file).text()
        expect(content).toBe("session content")
    })

    test("writes success.md when outcome.kind is success", async () => {
        await writeOutcomeFiles(tmpDir, "sid1", "", { kind: "success", content: "great" })
        const content = await Bun.file(path.join(tmpDir, "success.md")).text()
        expect(content).toBe("great")
    })

    test("writes failure.md when outcome.kind is failure", async () => {
        await writeOutcomeFiles(tmpDir, "sid1", "", { kind: "failure", content: "bad" })
        const content = await Bun.file(path.join(tmpDir, "failure.md")).text()
        expect(content).toBe("bad")
    })

    test("removes stale failure.md when writing success", async () => {
        await writeFile(path.join(tmpDir, "failure.md"), "stale")
        await writeOutcomeFiles(tmpDir, "sid1", "", { kind: "success", content: "ok" })
        const exists = await Bun.file(path.join(tmpDir, "failure.md")).exists()
        expect(exists).toBe(false)
    })

    test("removes stale success.md when writing failure", async () => {
        await writeFile(path.join(tmpDir, "success.md"), "stale")
        await writeOutcomeFiles(tmpDir, "sid1", "", { kind: "failure", content: "bad" })
        const exists = await Bun.file(path.join(tmpDir, "success.md")).exists()
        expect(exists).toBe(false)
    })
})

describe("findNextGroup", () => {
    test("returns null when directory is empty", async () => {
        const result = await findNextGroup(tmpDir)
        expect(result).toBeNull()
    })

    test("returns null when only dot-prefixed (completed) entries exist", async () => {
        await mkdir(path.join(tmpDir, ".01-my-task"))
        const result = await findNextGroup(tmpDir)
        expect(result).toBeNull()
    })

    test("returns the entry with the lowest numeric prefix among pending entries", async () => {
        await mkdir(path.join(tmpDir, "02-second"))
        await mkdir(path.join(tmpDir, "01-first-task"))
        const result = await findNextGroup(tmpDir)
        expect(result).toBe("01-first-task")
    })

    test("returns 01-first-task when 02-second and 01-first-task are present", async () => {
        await mkdir(path.join(tmpDir, "02-second"))
        await mkdir(path.join(tmpDir, "01-first-task"))
        const result = await findNextGroup(tmpDir)
        expect(result).toBe("01-first-task")
    })

    test("excludes entries ending in -failed", async () => {
        await mkdir(path.join(tmpDir, "01-my-task-failed"))
        const result = await findNextGroup(tmpDir)
        expect(result).toBeNull()
    })

    test("excludes entries ending in .deleted", async () => {
        await mkdir(path.join(tmpDir, "01-my-task.deleted"))
        const result = await findNextGroup(tmpDir)
        expect(result).toBeNull()
    })

    test("returns pending entry when -failed and .deleted entries also exist", async () => {
        await mkdir(path.join(tmpDir, "01-first-task-failed"))
        await mkdir(path.join(tmpDir, "02-second-task.deleted"))
        await mkdir(path.join(tmpDir, "03-third-task"))
        const result = await findNextGroup(tmpDir)
        expect(result).toBe("03-third-task")
    })
})

describe("collectTasks", () => {
    test("returns empty array for empty directory", async () => {
        const result = await collectTasks(tmpDir)
        expect(result).toEqual([])
    })

    test("skips entries ending with .deleted", async () => {
        await mkdir(path.join(tmpDir, "01-my-task.deleted"))
        const result = await collectTasks(tmpDir)
        expect(result).toEqual([])
    })

    test("skips entries without a XX- numeric prefix", async () => {
        await mkdir(path.join(tmpDir, "no-prefix"))
        const result = await collectTasks(tmpDir)
        expect(result).toEqual([])
    })

    test("returns one TaskInfo per regular task entry", async () => {
        await mkdir(path.join(tmpDir, "01-my_task"))
        const result = await collectTasks(tmpDir)
        expect(result).toHaveLength(1)
        expect(result[0].taskNumber).toBe("01")
        expect(result[0].description).toBe("my task")
    })

    test("recurses into concurrent groups and returns one TaskInfo per sub-entry", async () => {
        const groupDir = path.join(tmpDir, "01-concurrent_group")
        await mkdir(groupDir)
        await mkdir(path.join(groupDir, "task-a"))
        await mkdir(path.join(groupDir, "task-b"))
        const result = await collectTasks(tmpDir)
        expect(result).toHaveLength(2)
        expect(result.every(s => s.taskNumber === "01")).toBe(true)
    })

    test("sorts results by taskNumber numerically", async () => {
        await mkdir(path.join(tmpDir, "03-third"))
        await mkdir(path.join(tmpDir, "01-first"))
        await mkdir(path.join(tmpDir, "02-second"))
        const result = await collectTasks(tmpDir)
        expect(result.map(s => s.taskNumber)).toEqual(["01", "02", "03"])
    })
})

describe("findPlanDir", () => {
    test("returns null when plan doesn't exist in any location", async () => {
        const result = await findPlanDir(tmpDir, "my-plan")
        expect(result).toBeNull()
    })

    test("returns path under build/ when plan exists there", async () => {
        const planDir = path.join(tmpDir, ".autocode", "build", "my-plan")
        await mkdir(planDir, { recursive: true })
        const result = await findPlanDir(tmpDir, "my-plan")
        expect(result).toBe(planDir)
    })

    test("returns path under failed/ when plan exists there but not build/", async () => {
        const planDir = path.join(tmpDir, ".autocode", "failed", "my-plan")
        await mkdir(planDir, { recursive: true })
        const result = await findPlanDir(tmpDir, "my-plan")
        expect(result).toBe(planDir)
    })

    test("returns path under review/ when plan exists there but not build/ or failed/", async () => {
        const planDir = path.join(tmpDir, ".autocode", "review", "my-plan")
        await mkdir(planDir, { recursive: true })
        const result = await findPlanDir(tmpDir, "my-plan")
        expect(result).toBe(planDir)
    })
})

describe("resolveTaskDir", () => {
    test("without taskName: returns null when no pending tasks exist", async () => {
        const planDir = path.join(tmpDir, ".autocode", "build", "my-plan")
        await mkdir(planDir, { recursive: true })
        const result = await resolveTaskDir(tmpDir, "my-plan")
        expect(result).toBeNull()
    })

    test("without taskName: returns path to lowest-numbered pending group", async () => {
        const planDir = path.join(tmpDir, ".autocode", "build", "my-plan")
        await mkdir(planDir, { recursive: true })
        await mkdir(path.join(planDir, "02-second"))
        await mkdir(path.join(planDir, "01-first"))
        const result = await resolveTaskDir(tmpDir, "my-plan")
        expect(result).toBe(path.join(planDir, "01-first"))
    })

    test("with taskName: returns null when task doesn't exist", async () => {
        const planDir = path.join(tmpDir, ".autocode", "build", "my-plan")
        await mkdir(planDir, { recursive: true })
        const result = await resolveTaskDir(tmpDir, "my-plan", "01-nonexistent")
        expect(result).toBeNull()
    })

    test("with taskName: finds task by logical name (stripping leading dot)", async () => {
        const planDir = path.join(tmpDir, ".autocode", "build", "my-plan")
        await mkdir(planDir, { recursive: true })
        const taskDir = path.join(planDir, ".01-my-task")
        await mkdir(taskDir)
        const result = await resolveTaskDir(tmpDir, "my-plan", "01-my-task")
        expect(result).toBe(taskDir)
    })

    test("with taskName: finds task by logical name (stripping -failed suffix)", async () => {
        const planDir = path.join(tmpDir, ".autocode", "build", "my-plan")
        await mkdir(planDir, { recursive: true })
        const taskDir = path.join(planDir, "01-my-task-failed")
        await mkdir(taskDir)
        const result = await resolveTaskDir(tmpDir, "my-plan", "01-my-task")
        expect(result).toBe(taskDir)
    })

    test("with taskName: searches inside concurrent groups", async () => {
        const planDir = path.join(tmpDir, ".autocode", "build", "my-plan")
        await mkdir(planDir, { recursive: true })
        const groupDir = path.join(planDir, "01-concurrent_group")
        await mkdir(groupDir)
        const subTaskDir = path.join(groupDir, "01-sub-task")
        await mkdir(subTaskDir)
        const result = await resolveTaskDir(tmpDir, "my-plan", "01-sub-task")
        expect(result).toBe(subTaskDir)
    })
})
