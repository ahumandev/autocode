import { tool, ToolDefinition, PluginInput } from "@opencode-ai/plugin"
import { mkdir, readdir, readFile, rename, writeFile } from "fs/promises"
import path from "path"
import { validateNonEmpty, retryResponse, abortResponse, successResponse } from "@/utils/validation"
import {
    type MessageEntry,
    type FailureType,
    type TaskFailure,
    formatSessionMarkdown,
    extractTaskResult,
    makeTimestamp,
    buildReviewMarkdown,
    stripTaskNameDecorations,
    collectTasks,
    findSessionId,
    writeOutcomeFiles,
    findNextGroup,
    resolveTaskDir,
    findPlanDir,
} from "@/utils/tasks"

type Client = PluginInput["client"]

/**
 * Appended to the system prompt of every agent session spawned by the orchestrator.
 * Instructs the agent to wrap its final response in <success> or <failure> XML tags.
 * This is ONLY injected when sessions are spawned via the orchestrate tools — agents
 * called directly (outside orchestration) are not affected.
 */
const PROMPT_RESPONSE = `
`.trimEnd()

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
        planDir: string,
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

        // ── Skip if already done / failed ────────────────────────────────────

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

        // ── Determine agent name from {agent}.prompt.md filename ─────────────

        const dirFiles = await readdir(inFlightDir).catch(() => [] as string[])
        const agentPromptFile = dirFiles.find(
            f => f.endsWith(".prompt.md") && f !== "test.prompt.md"
        )
        let agentName: string
        let agentPromptContent: string
        
        // Read goal.md
        const goalPath = path.join(planDir, "goal.md")
        let goalContent = ""
        try { goalContent = await readFile(goalPath, "utf-8") } catch {}

        if (agentPromptFile) {
            agentName = agentPromptFile.replace(".prompt.md", "")
            agentPromptContent = await readFile(path.join(inFlightDir, agentPromptFile), "utf-8")
            if (goalContent.trim()) {
                agentPromptContent = `# Background\n\n${goalContent.trim()}\n\n${agentPromptContent}`
            }
        } else {
            return {
                finalDir: inFlightDir,
                failure: {
                    failure: `No prompt file found for '${taskDisplayName}'`,
                    sessionFile: path.join(inFlightDir, "failure.md"),
                    sessionId: "",
                    buildSessionId: "",
                    failureType: "tool_error" as FailureType,
                    failureDetails: "missing_prompt",
                },
            }
        }

        // ── Read test prompt (optional) ───────────────────────────────────────

        const testPromptPath = path.join(inFlightDir, "test.prompt.md")
        let testPromptContent: string | null = null
        try { 
            testPromptContent = await readFile(testPromptPath, "utf-8") 
            if (goalContent.trim()) {
                testPromptContent = `# Background\n\n${goalContent.trim()}\n\n${testPromptContent}`
            }
        } catch { /* optional */ }

        // ── Run agent session ─────────────────────────────────────────────────

        let sid = "error"
        let agentMessages: MessageEntry[] = []

        // Check for existing agent session to reconnect
        const existingAgentSession = dirFiles.find(
            f => f.startsWith(`${agentName}.session.`) && f.endsWith(".md")
        )
        const priorAgentSessionId = existingAgentSession
            ? existingAgentSession.slice(`${agentName}.session.`.length, -".md".length)
            : null

        let reconnected = false
        if (priorAgentSessionId) {
            try {
                await client.session.prompt({
                    path: { id: priorAgentSessionId },
                    body: {
                        agent: agentName,
                        parts: [{ type: "text", text: "continue" }],
                    },
                    throwOnError: true,
                })
                const resp = await client.session.messages({
                    path: { id: priorAgentSessionId },
                    throwOnError: true,
                })
                sid = priorAgentSessionId
                agentMessages = (resp.data ?? []) as MessageEntry[]
                reconnected = true
            } catch {
                // Reconnect failed — fall through to fresh run
            }
        }

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
                        agent: agentName,
                        system: PROMPT_RESPONSE,
                        parts: [{ type: "text", text: agentPromptContent }],
                    },
                    throwOnError: true,
                })

                const resp = await client.session.messages({
                    path: { id: sid },
                    throwOnError: true,
                })
                agentMessages = (resp.data ?? []) as MessageEntry[]
            } catch (err: any) {
                const failure = `Agent session failed for '${taskDisplayName}': ${err.message}`
                await writeFile(
                    path.join(inFlightDir, `${agentName}.session.${sid}.md`),
                    `# Error\n\n${failure}\n`,
                    "utf-8",
                ).catch(() => {})
                await writeFile(
                    path.join(inFlightDir, "failure.md"),
                    err.message,
                    "utf-8",
                ).catch(() => {})
                const failedDir = `${inFlightDir}.failed`
                await rename(inFlightDir, failedDir).catch(() => {})
                return {
                    finalDir: failedDir,
                    failure: {
                        failure,
                        sessionFile: path.join(failedDir, `${agentName}.session.${sid}.md`),
                        sessionId: sid,
                        buildSessionId: sid,
                        failureType: "task_session" as FailureType,
                        failureDetails: err.message,
                    },
                }
            }
        }

        // Write agent session transcript
        await writeFile(
            path.join(inFlightDir, `${agentName}.session.${sid}.md`),
            formatSessionMarkdown(agentPromptContent, agentMessages),
            "utf-8",
        ).catch(() => {})

        // ── Write agent result file ───────────────────────────────────────────

        const agentResult = extractTaskResult(agentMessages)
        const agentTimestamp = makeTimestamp()
        const agentResultContent = agentResult.kind === "success"
            ? `<success>${agentResult.content}</success>`
            : `<failure>${agentResult.content}</failure>`
        await writeFile(
            path.join(inFlightDir, `${agentName}.result.${agentTimestamp}.md`),
            agentResultContent,
            "utf-8",
        ).catch(() => {})

        // ── Agent reported <failure> → short-circuit for orchestrate agent to handle ──
        // Skip test and recover phases; return agent_failure so the tool can use retryResponse
        // to give the orchestrate AGENT the failure details and let it modify the task schedule.
        if (agentResult.kind === "failure") {
            await writeFile(path.join(inFlightDir, "failure.md"), agentResult.content, "utf-8").catch(() => {})
            const failedDir = `${inFlightDir}.failed`
            await rename(inFlightDir, failedDir).catch(() => {})
            return {
                finalDir: failedDir,
                failure: {
                    failure: `Task '${taskDisplayName}' agent reported failure`,
                    sessionFile: path.join(failedDir, `${agentName}.session.${sid}.md`),
                    sessionId: sid,
                    buildSessionId: sid,
                    failureType: "agent_failure" as FailureType,
                    failureDetails: agentResult.content,
                    agentName,
                },
            }
        }

        // ── Run test session (if test.prompt.md exists) ───────────────────────

        let testSucceeded = true // default: no test = pass
        let testOutput = ""
        let testSid = "error"

        if (testPromptContent && agentName !== "test") {
            try {
                const testCreated = await client.session.create({
                    body: { title: `Test: ${taskDisplayName}` },
                    throwOnError: true,
                })
                testSid = testCreated.data.id

                await client.session.prompt({
                    path: { id: testSid },
                    body: {
                        agent: "test",
                        parts: [{ type: "text", text: testPromptContent }],
                    },
                    throwOnError: true,
                })

                const testResp = await client.session.messages({
                    path: { id: testSid },
                    throwOnError: true,
                })
                const testMessages = (testResp.data ?? []) as MessageEntry[]

                // Write test session transcript
                await writeFile(
                    path.join(inFlightDir, `test.session.${testSid}.md`),
                    formatSessionMarkdown(testPromptContent, testMessages),
                    "utf-8",
                ).catch(() => {})

                const testResult = extractTaskResult(testMessages)
                testOutput = testResult.content
                testSucceeded = testResult.kind === "success"

                const testTimestamp = makeTimestamp()
                const testResultContent = testResult.kind === "success"
                    ? `<success>${testResult.content}</success>`
                    : `<failure>${testResult.content}</failure>`
                await writeFile(
                    path.join(inFlightDir, `test.result.${testTimestamp}.md`),
                    testResultContent,
                    "utf-8",
                ).catch(() => {})
            } catch (err: any) {
                // Test session threw — treat as test failure
                testSucceeded = false
                testOutput = err.message
                await writeFile(
                    path.join(inFlightDir, `test.session.${testSid}.md`),
                    `# Error\n\n${err.message}\n`,
                    "utf-8",
                ).catch(() => {})
                const testTimestamp = makeTimestamp()
                await writeFile(
                    path.join(inFlightDir, `test.result.${testTimestamp}.md`),
                    `<failure>${err.message}</failure>`,
                    "utf-8",
                ).catch(() => {})
            }
        }

        // ── Both succeeded → done ─────────────────────────────────────────────

        if (agentResult.kind === "success" && testSucceeded) {
            await writeFile(path.join(inFlightDir, "success.md"), "", "utf-8").catch(() => {})
            const doneDir = path.join(path.dirname(inFlightDir), `.${path.basename(inFlightDir)}`)
            await rename(inFlightDir, doneDir).catch(() => {})
            return { finalDir: doneDir, failure: null }
        }

        // ── Either failed → invoke recover agent ───────────────────────────

        // Read background.md if present
        const backgroundPath = path.join(inFlightDir, "background.md")
        let backgroundContent = ""
        try { backgroundContent = await readFile(backgroundPath, "utf-8") } catch {}

        // Collect ALL result files in timestamp order
        const currentDirFiles = await readdir(inFlightDir).catch(() => [] as string[])
        const resultFiles = currentDirFiles
            .filter(f => f.endsWith(".md") && f.includes(".result."))
            .sort() // lexicographic = chronological due to YYYY-MM-DD_HH-mm-ss prefix

        const allResultsText = await Promise.all(
            resultFiles.map(async f => {
                const content = await readFile(path.join(inFlightDir, f), "utf-8").catch(() => "")
                return `### ${f}\n${content}`
            })
        )

        // Determine failure details from the failing test (agent_failure is handled above)
        let failureDetails = testOutput

        // Build recover message
        const recoverMessage = [
            goalContent.trim() ? `# BACKGROUND (Goal)\n${goalContent.trim()}` : null,
            backgroundContent ? `# BACKGROUND (Task)\n${backgroundContent}` : null,
            `# ORIGINAL PROMPT\n<prompt>\n${agentPromptContent}\n</prompt>`,
            `# RESULTS\n${allResultsText.join("\n\n")}`,
            `# FAILURE INSTRUCTION\nThe above results contain a failure. Please correct the implementation and respond with <success> or <failure>.`,
        ].filter(Boolean).join("\n\n")

        // Spawn recover agent
        let recoverKind: "success" | "failure" = "failure"
        let recoverSid = "error"
        try {
            const corrCreated = await client.session.create({
                body: { title: `Recover: ${taskDisplayName}` },
                throwOnError: true,
            })
            recoverSid = corrCreated.data.id

            await client.session.prompt({
                path: { id: recoverSid },
                body: {
                    agent: "recover",
                    parts: [{ type: "text", text: recoverMessage }],
                },
                throwOnError: true,
            })

            const corrResp = await client.session.messages({
                path: { id: recoverSid },
                throwOnError: true,
            })
            const corrMessages = (corrResp.data ?? []) as MessageEntry[]

            // Write recover session transcript
            await writeFile(
                path.join(inFlightDir, `recover.session.${recoverSid}.md`),
                formatSessionMarkdown(recoverMessage, corrMessages),
                "utf-8",
            ).catch(() => {})

            const corrResult = extractTaskResult(corrMessages)
            recoverKind = corrResult.kind
            failureDetails = corrResult.content

            const corrTimestamp = makeTimestamp()
            const corrResultContent = corrResult.kind === "success"
                ? `<success>${corrResult.content}</success>`
                : `<failure>${corrResult.content}</failure>`
            await writeFile(
                path.join(inFlightDir, `recover.result.${corrTimestamp}.md`),
                corrResultContent,
                "utf-8",
            ).catch(() => {})
        } catch (err: any) {
            // Recover session threw — fall through to failure
            recoverKind = "failure"
            failureDetails = err.message
            await writeFile(
                path.join(inFlightDir, `recover.session.${recoverSid}.md`),
                `# Error\n\n${err.message}\n`,
                "utf-8",
            ).catch(() => {})
        }

        // If recover succeeded and there's a test, re-run test to verify
        if (recoverKind === "success" && testPromptContent && agentName !== "test") {
            let verifySid = "error"
            try {
                const verifyCreated = await client.session.create({
                    body: { title: `Verify: ${taskDisplayName}` },
                    throwOnError: true,
                })
                verifySid = verifyCreated.data.id

                await client.session.prompt({
                    path: { id: verifySid },
                    body: {
                        agent: "test",
                        parts: [{ type: "text", text: testPromptContent }],
                    },
                    throwOnError: true,
                })

                const verifyResp = await client.session.messages({
                    path: { id: verifySid },
                    throwOnError: true,
                })
                const verifyMessages = (verifyResp.data ?? []) as MessageEntry[]

                // Write verify session transcript
                await writeFile(
                    path.join(inFlightDir, `test.session.${verifySid}.md`),
                    formatSessionMarkdown(testPromptContent, verifyMessages),
                    "utf-8",
                ).catch(() => {})

                const verifyResult = extractTaskResult(verifyMessages)
                const verifyTimestamp = makeTimestamp()
                const verifyResultContent = verifyResult.kind === "success"
                    ? `<success>${verifyResult.content}</success>`
                    : `<failure>${verifyResult.content}</failure>`
                await writeFile(
                    path.join(inFlightDir, `test.result.${verifyTimestamp}.md`),
                    verifyResultContent,
                    "utf-8",
                ).catch(() => {})

                if (verifyResult.kind === "success") {
                    await writeFile(path.join(inFlightDir, "success.md"), "", "utf-8").catch(() => {})
                    const doneDir = path.join(path.dirname(inFlightDir), `.${path.basename(inFlightDir)}`)
                    await rename(inFlightDir, doneDir).catch(() => {})
                    return { finalDir: doneDir, failure: null }
                }
                failureDetails = verifyResult.content
            } catch (err: any) {
                failureDetails = err.message
                await writeFile(
                    path.join(inFlightDir, `test.session.${verifySid}.md`),
                    `# Error\n\n${err.message}\n`,
                    "utf-8",
                ).catch(() => {})
            }
        } else if (recoverKind === "success" && !testPromptContent) {
            // Recover succeeded, no test to run — mark done
            await writeFile(path.join(inFlightDir, "success.md"), "", "utf-8").catch(() => {})
            const doneDir = path.join(path.dirname(inFlightDir), `.${path.basename(inFlightDir)}`)
            await rename(inFlightDir, doneDir).catch(() => {})
            return { finalDir: doneDir, failure: null }
        }

        // Still failing — write failure.md and mark as failed
        await writeFile(path.join(inFlightDir, "failure.md"), failureDetails, "utf-8").catch(() => {})
        const failedDir = `${inFlightDir}.failed`
        await rename(inFlightDir, failedDir).catch(() => {})
        return {
            finalDir: failedDir,
            failure: {
                failure: `Task '${taskDisplayName}' failed after recover attempt`,
                sessionFile: path.join(failedDir, "failure.md"),
                sessionId: recoverSid !== "error" ? recoverSid : sid,
                buildSessionId: sid,
                failureType: "task_failure" as FailureType,
                failureDetails,
            },
        }
    }

    // ─── tool: autocode_orchestrate_resume ──────────────────────────────────

    /**
     * Run every task in the plan to completion, then promote the plan to review.
     *
     * Plans remain in `.autocode/build/{plan}/` during execution.
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
     * On full completion moves `.autocode/build/{plan}/` → `.autocode/review/{plan}/`.
     * On permanent failure moves `.autocode/build/{plan}/` → `.autocode/failed/{plan}/`.
     *
     * Return shapes:
     *   { done: true,  reviewPath }
     *   { done: false, success: false, task, session_id, build_session_id, reason, sessionFile }
     *   { done: false, success: false, group, failures: [{task, session_id, build_session_id, reason, sessionFile}] }
     */
    const autocode_orchestrate_resume: ToolDefinition = tool({
        description:
            "Run every task in the plan autonomously and promote the plan to review when finished. " +
            "Plans remain in `.autocode/build/` during execution. " +
            "Loops internally through all task groups (lowest numeric prefix first). " +
            "Sequential tasks run one at a time; concurrent groups run in parallel. " +
            "For each task: spawns an agent session (build) — skipped if `success.md` exists, " +
            "resumed via `{agent}.session.{id}.md` if a prior run crashed without writing an outcome. " +
            "Outcome files written: `{agent}.session.{id}.md` + `success.md` or `failure.md`. " +
            "Completed task directories are dot-hidden. " +
            "On full completion moves `.autocode/build/{plan}/` to `.autocode/review/{plan}/`. " +
            "On permanent failure moves `.autocode/build/{plan}/` to `.autocode/failed/{plan}/`. " +
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

            const buildDir  = path.join(context.worktree, ".autocode", "build",  args.plan_name)
            const failedDir = path.join(context.worktree, ".autocode", "failed", args.plan_name)
            const reviewDir = path.join(context.worktree, ".autocode", "review", args.plan_name)

            // Verify the plan exists in build/
            try {
                await readdir(buildDir)
            } catch {
                return abortResponse(toolName, `Plan '${args.plan_name}' not found in .autocode/build/`)
            }

            const planDir = buildDir

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
                                planDir,
                            ).then(({ failure }) => ({ taskName, failure }))
                        )
                    )

                    const failures = results.filter(r => r.failure !== null)
                    if (failures.length > 0) {
                        const agentFailures = failures.filter(f => f.failure!.failureType === "agent_failure")
                        const hardFailures  = failures.filter(f => f.failure!.failureType !== "agent_failure")

                        // Always rename the group dir to .failed so delete_step can find it
                        const failedGroupDir = `${inFlightGroupDir}.failed`
                        await rename(inFlightGroupDir, failedGroupDir).catch(() => {})

                        if (hardFailures.length > 0) {
                            // At least one hard failure (session crash, tool error) — move plan to failed/
                            await mkdir(path.join(context.worktree, ".autocode", "failed"), { recursive: true })
                            await rename(planDir, failedDir).catch(() => {})
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

                        // All failures are agent_failure — keep plan in build/, return retryResponse
                        const failureMessages = agentFailures
                            .map(f => `- "${f.taskName}" (agent: "${f.failure!.agentName ?? "unknown"}"): ${f.failure!.failureDetails}`)
                            .join("\n")
                        const constraint = [
                            `be taken before resuming. The following concurrent tasks in group "${groupName}" reported failures:`,
                            ``,
                            failureMessages,
                            ``,
                            `The failure messages above are recovery instructions intended for subagents — do NOT execute them yourself.`,
                            `Modify the task schedule for plan "${args.plan_name}" to incorporate the recovery, then call autocode_orchestrate_resume({ plan_name: "${args.plan_name}" }) again.`,
                        ].join("\n")
                        return retryResponse(sid, toolName, "recovery_action", constraint)
                    }

                    // All concurrent tasks succeeded — hide the group dir with a dot
                    const doneGroupDir = path.join(planDir, `.${inFlightGroupName}`)
                    await rename(inFlightGroupDir, doneGroupDir).catch(() => {})

                } else {
                    const { failure } = await executeTask(groupDir, groupName, planDir)
                    if (failure) {
                        if (failure.failureType === "agent_failure") {
                            // Agent returned <failure> — keep plan in build/, return retryResponse
                            // so the orchestrate AGENT can modify the task schedule and resume.
                            const constraint = [
                                `be taken before resuming. Task "${groupName}" using agent "${failure.agentName ?? "unknown"}" reported this failure:`,
                                ``,
                                failure.failureDetails,
                                ``,
                                `The failure message above is recovery instructions intended for a subagent — do NOT execute it yourself.`,
                                `Modify the task schedule for plan "${args.plan_name}" to incorporate the recovery, then call autocode_orchestrate_resume({ plan_name: "${args.plan_name}" }) again.`,
                            ].join("\n")
                            return retryResponse(sid, toolName, "recovery_action", constraint)
                        }
                        // Hard failure (session crash, tool error, etc.) — move plan to failed/
                        await mkdir(path.join(context.worktree, ".autocode", "failed"), { recursive: true })
                        await rename(planDir, failedDir).catch(() => {})
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

            const candidates = [
                path.join(context.worktree, ".autocode", "build",   args.plan_name, "goal.md"),
                path.join(context.worktree, ".autocode", "failed",  args.plan_name, "goal.md"),
                path.join(context.worktree, ".autocode", "review",  args.plan_name, "goal.md"),
            ]
            let goalContent = ""
            for (const p of candidates) {
                try {
                    goalContent = await readFile(p, "utf-8")
                    break
                } catch {}
            }
            
            let finalFixMessage = args.fix_message
            if (goalContent.trim()) {
                finalFixMessage = `# Background\n\n${goalContent.trim()}\n\n${finalFixMessage}`
            }

            try {
                await client.session.prompt({
                    path: { id: args.session_id },
                    body: {
                        agent: "explore",
                        parts: [{ type: "text", text: finalFixMessage }],
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
                    formatSessionMarkdown(finalFixMessage, messages),
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
            let finalInstruction = instruction

            const candidates = [
                path.join(context.worktree, ".autocode", "build",   args.plan_name, "goal.md"),
                path.join(context.worktree, ".autocode", "failed",  args.plan_name, "goal.md"),
                path.join(context.worktree, ".autocode", "review",  args.plan_name, "goal.md"),
            ]
            let goalContent = ""
            for (const p of candidates) {
                try {
                    goalContent = await readFile(p, "utf-8")
                    break
                } catch {}
            }
            if (goalContent.trim()) {
                finalInstruction = `# Background\n\n${goalContent.trim()}\n\n${finalInstruction}`
            }

            try {
                await client.session.prompt({
                    path: { id: sessionId },
                    body: {
                        agent: "execute",
                        parts: [{ type: "text", text: finalInstruction }],
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
                const buildPrompt = await readFile(path.join(dir, "prompt.md"), "utf-8").catch(() => finalInstruction)

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

            // Plan may still be in build/ (during execution), failed/ (permanent failure), or review/ (after completion)
            const candidates = [
                path.join(context.worktree, ".autocode", "build",   args.plan_name, "plan.md"),
                path.join(context.worktree, ".autocode", "failed",  args.plan_name, "plan.md"),
                path.join(context.worktree, ".autocode", "review",  args.plan_name, "plan.md"),
            ]
            for (const p of candidates) {
                try {
                    const content = await readFile(p, "utf-8")
                    return successResponse(sid, toolName, content)
                } catch { /* try next */ }
            }
            return abortResponse(toolName, `plan.md not found for plan '${args.plan_name}' in build/, failed/, or review/`)
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
                const dirFiles = await readdir(dir)
                const agentPromptFile = dirFiles.find(
                    f => f.endsWith(".prompt.md") && f !== "test.prompt.md"
                )
                if (agentPromptFile) {
                    const agentName = agentPromptFile.replace(".prompt.md", "")
                    const content = await readFile(path.join(dir, agentPromptFile), "utf-8")
                    return successResponse(sid, toolName, `# Agent: ${agentName}\n\n${content}`)
                }
                // Fallback: legacy prompt.md
                const content = await readFile(path.join(dir, "prompt.md"), "utf-8")
                return successResponse(sid, toolName, content)
            } catch (err: any) {
                return abortResponse(toolName, `No prompt file found in '${dir}': ${err.message}`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_review ──────────────────────────────────

    /**
     * Generates `review.md` by spawning the `review` (or `report`) agent with
     * plan.md and the latest agent result from each task directory.
     * Falls back to `buildReviewMarkdown` if the agent session fails.
     */
    const autocode_orchestrate_review: ToolDefinition = tool({
        description:
            "Generate and write the review report (review.md) for a completed plan. " +
            "Spawns the review agent with plan.md and each task's latest result file, " +
            "producing a structured report with a progress summary and testing tutorial. " +
            "Falls back to a static markdown report if the agent session fails. " +
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
                path.join(context.worktree, ".autocode", "failed",  args.plan_name),
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
                    `match an existing plan directory — '${args.plan_name}' was not found in review/, failed/, or build/`,
                )
            }

            const reviewPath = path.join(planDir, "review.md")

            try {
                // Read plan.md
                const planContent = await readFile(path.join(planDir, "plan.md"), "utf-8").catch(() => "")

                // Collect steps and find latest agent result for each
                const steps = await collectTasks(planDir)
                type TaskResult = { taskName: string; agentName: string; resultContent: string }
                const taskResults: TaskResult[] = []

                for (const step of steps) {
                    if (step.outcome.kind === "incomplete") continue
                    const stepFiles = await readdir(step.dirPath).catch(() => [] as string[])
                    // Find latest {agent}.result.*.md — exclude test.result and recover.result
                    const agentResultFiles = stepFiles
                        .filter(f =>
                            f.endsWith(".md") &&
                            f.includes(".result.") &&
                            !f.startsWith("test.result.") &&
                            !f.startsWith("recover.result.")
                        )
                        .sort()
                    const latestResultFile = agentResultFiles[agentResultFiles.length - 1]
                    if (latestResultFile) {
                        const resultContent = await readFile(
                            path.join(step.dirPath, latestResultFile), "utf-8"
                        ).catch(() => "")
                        const detectedAgent = latestResultFile.split(".result.")[0]
                        taskResults.push({
                            taskName: step.description,
                            agentName: detectedAgent,
                            resultContent,
                        })
                    } else {
                        // Fall back to success.md / failure.md content
                        taskResults.push({
                            taskName: step.description,
                            agentName: "unknown",
                            resultContent: step.outcome.content,
                        })
                    }
                }

                // Build concatenated success responses for the document agent
                const successResults = taskResults
                    .filter(r => r.resultContent.includes("<success>"))
                const concatenatedSuccesses = successResults
                    .map(({ taskName, agentName: an, resultContent }) =>
                        `## ${taskName} (${an})\n${resultContent}`
                    )
                    .join("\n\n")

                // Spawn document agent with concatenated success responses (best-effort)
                const spawnDocumentAgent = async () => {
                    if (!concatenatedSuccesses) return
                    const docPrompt = [
                        "# Recently Completed Tasks",
                        "The following tasks were just completed. Update the project documentation to reflect these changes.",
                        "",
                        concatenatedSuccesses,
                    ].join("\n")
                    try {
                        const docCreated = await client.session.create({
                            body: { title: `Document: ${args.plan_name}` },
                            throwOnError: true,
                        })
                        const docSid = docCreated.data.id
                        await client.session.prompt({
                            path: { id: docSid },
                            body: {
                                agent: "document",
                                parts: [{ type: "text", text: docPrompt }],
                            },
                            throwOnError: true,
                        })
                    } catch { /* documentation update is best-effort */ }
                }

                // Spawn optimize agent on recent uncommitted changes (best-effort)
                const spawnOptimizeAgent = async () => {
                    const optPrompt = concatenatedSuccesses
                        ? [
                            "# Recently Completed Tasks",
                            "The following tasks were just implemented. Optimize the resulting uncommitted code changes.",
                            "",
                            concatenatedSuccesses,
                          ].join("\n")
                        : "Optimize the recent uncommitted code changes."
                    try {
                        const optCreated = await client.session.create({
                            body: { title: `Optimize: ${args.plan_name}` },
                            throwOnError: true,
                        })
                        const optSid = optCreated.data.id
                        await client.session.prompt({
                            path: { id: optSid },
                            body: {
                                agent: "optimize",
                                parts: [{ type: "text", text: optPrompt }],
                            },
                            throwOnError: true,
                        })
                    } catch { /* optimization is best-effort */ }
                }

                // Build review prompt for the agent
                const reviewPrompt = [
                    "# Plan",
                    planContent,
                    "---",
                    "# Task Results",
                    ...taskResults.map(({ taskName, agentName: an, resultContent }) =>
                        `## Task: ${taskName} (${an})\n${resultContent}`
                    ),
                    "---",
                    "# Review Instructions",
                    "Generate a comprehensive review report for a human reviewer that:",
                    "1. Summarizes what was changed across all tasks",
                    "2. Provides a step-by-step tutorial for the reviewer to test the changes",
                    "3. Includes example input and expected output for each verification step",
                    "4. Highlights any tasks that required recover",
                ].join("\n\n")

                // Spawn review agent — try 'review' first, fall back to 'report'
                let reviewMarkdown: string | null = null
                for (const reviewAgent of ["review", "report"]) {
                    try {
                        const created = await client.session.create({
                            body: { title: `Review: ${args.plan_name}` },
                            throwOnError: true,
                        })
                        const reviewSid = created.data.id

                        await client.session.prompt({
                            path: { id: reviewSid },
                            body: {
                                agent: reviewAgent,
                                parts: [{ type: "text", text: reviewPrompt }],
                            },
                            throwOnError: true,
                        })

                        const resp = await client.session.messages({
                            path: { id: reviewSid },
                            throwOnError: true,
                        })
                        const reviewMessages = (resp.data ?? []) as MessageEntry[]

                        // Extract the agent's full text output as the review content
                        const assistant = reviewMessages.filter(m => m.info.role === "assistant")
                        if (assistant.length > 0) {
                            reviewMarkdown = assistant[assistant.length - 1].parts
                                .filter(p => p.type === "text")
                                .map(p => p.text ?? "")
                                .join("\n")
                        }
                        break
                    } catch {
                        // Try next agent name
                    }
                }

                if (reviewMarkdown) {
                    await writeFile(reviewPath, reviewMarkdown, "utf-8")
                    await spawnOptimizeAgent()
                    await spawnDocumentAgent()
                    return successResponse(sid, toolName, { review_path: reviewPath })
                }

                // Fallback: static markdown report
                const markdown = buildReviewMarkdown(args.plan_name, steps)
                await writeFile(reviewPath, markdown, "utf-8")
                await spawnOptimizeAgent()
                await spawnDocumentAgent()
                return successResponse(sid, toolName, { review_path: reviewPath })
            } catch (err: any) {
                return abortResponse(toolName, `failed to generate review for plan '${args.plan_name}': ${err.message}`)
            }
        },
    })

    // ─── tool: autocode_orchestrate_list ────────────────────────────────────

    /**
     * List all plans available for orchestration in `.autocode/build/` and `.autocode/failed/`.
     *
     * Returns an array of unique plan directory names from both locations.
     * Each entry represents a plan that has been built or has permanently failed.
     */
    const autocode_orchestrate_list: ToolDefinition = tool({
        description: "List all plans available for orchestration in .autocode/build/ and .autocode/failed/.",
        args: {},
        async execute(_args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_list"
            const buildDir  = path.join(context.worktree, ".autocode", "build")
            const failedDir = path.join(context.worktree, ".autocode", "failed")
            const reviewDir = path.join(context.worktree, ".autocode", "review")

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
                return successResponse(sid, toolName, {
                    build: await getPlans(buildDir),
                    failed: await getPlans(failedDir),
                    review: await getPlans(reviewDir),
                })
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
                path.join(context.worktree, ".autocode", "failed",  args.plan_name, "plan.md"),
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
                path.join(context.worktree, ".autocode", "failed",  args.plan_name),
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

            const steps = await collectTasks(planDir)
            const lines: string[] = []
            lines.push("| Step | Description | Status |")
            lines.push("|------|-------------|--------|")
            for (const s of steps) {
                const status =
                    s.outcome.kind === "success" ? "Success" :
                    s.outcome.kind === "failure" ? "Failure" :
                    "Incomplete"
                lines.push(`| ${s.taskNumber} | ${s.description} | ${status} |`)
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
            "Writes {agent}.prompt.md with the execute instructions, and optionally background.md and test.prompt.md. " +
            "For each shifted step, outcome files (success.md, failure.md, session.*.md) are hidden " +
            "by prefixing with .{timestamp}. so the step will re-run on next resume. " +
            "If step_index is omitted, inserts before the current pending step.",
        args: {
            plan_name: tool.schema.string().describe("The plan name"),
            step_name: tool.schema.string().describe("Logical name for the new step (e.g. 'add_validation'). Will become '{index:02}-{step_name}'."),
            agent: tool.schema.string().describe("Agent to execute this step (e.g. 'code', 'md', 'os', 'troubleshoot', 'git', 'browser', 'excel'). Determines which {agent}.prompt.md file is written."),
            execute: tool.schema.string().describe("Full execution instructions for the agent. Written to {agent}.prompt.md."),
            background: tool.schema.string().optional().describe("Optional context/reason for this task (max 40 words). Written to background.md if provided."),
            test: tool.schema.string().optional().describe("Optional verification instructions for the test agent. Written to test.prompt.md if provided."),
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
            const agentErr = validateNonEmpty(args.agent, sid, toolName, "agent")
            if (agentErr) return agentErr
            const executeErr = validateNonEmpty(args.execute, sid, toolName, "execute")
            if (executeErr) return executeErr

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

            // Create the new step directory and write task files
            const newStepName = `${String(insertIndex).padStart(2, "0")}-${args.step_name}`
            const newStepDir = path.join(planDir, newStepName)
            await mkdir(newStepDir, { recursive: true })
            await writeFile(path.join(newStepDir, `${args.agent}.prompt.md`), args.execute, "utf-8")
            if (args.background) {
                await writeFile(path.join(newStepDir, "background.md"), args.background, "utf-8")
            }
            if (args.test) {
                await writeFile(path.join(newStepDir, "test.prompt.md"), args.test, "utf-8")
            }

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


    /**
     * Abort the plan, move it to the failed directory, and write a review.md explaining the failure.
     */
    const autocode_orchestrate_abort: ToolDefinition = tool({
        description: "Abort the plan, move it to the failed directory, and write a review.md explaining the failure.",
        args: {
            plan_name: tool.schema.string().describe("The plan name"),
            what_went_wrong: tool.schema.string().describe("What went wrong"),
            why_it_is_critical: tool.schema.string().describe("Why it is critical"),
            suggested_corrective_actions: tool.schema.string().describe("Suggested corrective actions the user may consider"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_orchestrate_abort"

            const planNameErr = validateNonEmpty(args.plan_name, sid, toolName, "plan_name")
            if (planNameErr) return planNameErr

            const planDir = await findPlanDir(context.worktree, args.plan_name)
            if (!planDir) {
                return abortResponse(toolName, `Plan '${args.plan_name}' not found in .autocode/build/, failed/, or review/`)
            }

            const reviewContent = [
                "# Failure Review",
                "",
                "## What went wrong",
                args.what_went_wrong,
                "",
                "## Why it is critical",
                args.why_it_is_critical,
                "",
                "## Suggested corrective actions",
                args.suggested_corrective_actions
            ].join("\n")

            await writeFile(path.join(planDir, "review.md"), reviewContent, "utf-8")

            const failedParentDir = path.join(context.worktree, ".autocode", "failed")
            const targetDir = path.join(failedParentDir, args.plan_name)

            if (planDir !== targetDir) {
                await mkdir(failedParentDir, { recursive: true })
                await rename(planDir, targetDir)
            }

            return successResponse(sid, toolName, {
                message: `Plan '${args.plan_name}' has been aborted and moved to failed directory.`,
                review_path: path.join(targetDir, "review.md")
            })
        }
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
        autocode_orchestrate_abort,
    }
}
