// .opencode/tool/autocode-sdk.ts
import { tool } from "@opencode-ai/plugin"
import { executeTask, executeParallelTasks, abortSession } from "../../src/sdk/orchestrator"
import { createConfig } from "../../src/core/config"
import { updateSessionMeta, readSessionMeta, resetBusyTasks } from "../../src/core/state"
import { readFile, readdir, stat } from "fs/promises"
import path from "path"

function getConfig(context: { worktree: string }) {
  return createConfig(context.worktree)
}

/**
 * Execute a single build or test task via a headless SDK session.
 */
export const execute_task = tool({
  description:
    "Execute a single build or test task by spawning a headless OpenCode session with the solve or test agent. Reads the prompt file from the busy/ directory, sends it to the agent, waits for completion, and writes the session export as a .session.md file alongside the prompt.",
  args: {
    plan_name: tool.schema.string().describe("Plan directory name"),
    task_dir_name: tool.schema.string().describe("Task directory name (e.g., '0-setup_deps')"),
    task_type: tool.schema
      .enum(["build", "test"])
      .describe("Whether to run build.prompt.md (via solve agent) or test.prompt.md (via test agent)"),
    resume_session_id: tool.schema
      .string()
      .optional()
      .describe("Session ID to resume if retrying a failed task"),
    retry_context: tool.schema
      .string()
      .optional()
      .describe("Additional context to prepend to the prompt when retrying (error details, recovery hints)"),
  },
  async execute(args, context) {
    const config = getConfig(context)
    const promptFile = args.task_type === "build" ? "build.prompt.md" : "test.prompt.md"
    const agent = args.task_type === "build" ? "solve" : "test"

    const promptPath = path.join(
      config.rootDir, "build", args.plan_name,
      "busy", args.task_dir_name, promptFile,
    )

    let promptContent: string
    try {
      promptContent = await readFile(promptPath, "utf-8")
    } catch {
      return JSON.stringify({
        success: false,
        error: `Prompt file not found: ${promptPath}`,
      })
    }

    // Prepend retry context if provided
    if (args.retry_context) {
      promptContent = `${args.retry_context}\n\n---\n\n${promptContent}`
    }

    const result = await executeTask("http://localhost:4096", {
      planName: args.plan_name,
      taskPath: `${args.task_dir_name}/${promptFile}`,
      promptContent,
      agent,
      sessionId: args.resume_session_id,
    })

    // Write session markdown alongside prompt
    const sessionMdPath = promptPath.replace(".prompt.md", ".session.md")
    await Bun.write(sessionMdPath, result.sessionMarkdown)

    // Update session metadata
    await updateSessionMeta(config, args.plan_name, "build", (meta) => {
      const key = args.task_dir_name
      if (!meta.taskSessions[key]) {
        meta.taskSessions[key] = { retryCount: 0 }
      }
      if (args.task_type === "build") {
        meta.taskSessions[key].buildSessionId = result.sessionId
      } else {
        meta.taskSessions[key].testSessionId = result.sessionId
      }
      if (!result.success) {
        meta.taskSessions[key].lastError = result.error
        meta.taskSessions[key].retryCount++
      }
      return meta
    })

    return JSON.stringify({
      success: result.success,
      sessionId: result.sessionId,
      error: result.error,
      outputPreview: result.output.slice(0, 500),
    })
  },
})

/**
 * Execute multiple independent tasks concurrently.
 */
export const execute_parallel_tasks = tool({
  description:
    "Execute multiple independent tasks concurrently via separate SDK sessions. Used for unnumbered sibling tasks. Each task gets its own session. All tasks must be in the busy/ directory.",
  args: {
    plan_name: tool.schema.string().describe("Plan directory name"),
    task_dir_names: tool.schema
      .array(tool.schema.string())
      .describe("Array of task directory names to run in parallel"),
    task_type: tool.schema
      .enum(["build", "test"])
      .describe("Whether to run build or test prompts"),
  },
  async execute(args, context) {
    const config = getConfig(context)
    const promptFile = args.task_type === "build" ? "build.prompt.md" : "test.prompt.md"
    const agent = args.task_type === "build" ? "solve" : "test"

    const tasks = await Promise.all(
      args.task_dir_names.map(async (taskDir) => {
        const promptPath = path.join(
          config.rootDir, "build", args.plan_name,
          "busy", taskDir, promptFile,
        )
        const content = await readFile(promptPath, "utf-8")
        return {
          planName: args.plan_name,
          taskPath: `${taskDir}/${promptFile}`,
          promptContent: content,
          agent: agent as "solve" | "test",
        }
      }),
    )

    const results = await executeParallelTasks(
      "http://localhost:4096",
      tasks,
      config.parallelSessionsLimit,
    )

    // Write session markdowns and update metadata
    for (let i = 0; i < results.length; i++) {
      const taskDir = args.task_dir_names[i]
      const sessionFile = args.task_type === "build" ? "build.session.md" : "test.session.md"
      const sessionPath = path.join(
        config.rootDir, "build", args.plan_name,
        "busy", taskDir, sessionFile,
      )
      await Bun.write(sessionPath, results[i].sessionMarkdown)

      // Update session metadata
      await updateSessionMeta(config, args.plan_name, "build", (meta) => {
        if (!meta.taskSessions[taskDir]) {
          meta.taskSessions[taskDir] = { retryCount: 0 }
        }
        if (args.task_type === "build") {
          meta.taskSessions[taskDir].buildSessionId = results[i].sessionId
        } else {
          meta.taskSessions[taskDir].testSessionId = results[i].sessionId
        }
        if (!results[i].success) {
          meta.taskSessions[taskDir].lastError = results[i].error
          meta.taskSessions[taskDir].retryCount++
        }
        return meta
      })
    }

    return JSON.stringify(
      results.map((r, i) => ({
        task: args.task_dir_names[i],
        success: r.success,
        sessionId: r.sessionId,
        error: r.error,
      })),
    )
  },
})

/**
 * Emergency abort all running sessions for a plan.
 */
export const abort_plan_sessions = tool({
  description:
    "Emergency abort: immediately stop ALL running OpenCode sessions for a given plan. Aborts sessions and moves busy tasks back to accepted.",
  args: {
    plan_name: tool.schema.string().describe("Plan directory name"),
  },
  async execute(args, context) {
    const config = getConfig(context)

    // Read session metadata to find active sessions
    const meta = await readSessionMeta(config, args.plan_name, "build")

    let aborted = 0
    for (const [_taskName, taskSession] of Object.entries(meta.taskSessions)) {
      if (taskSession.buildSessionId) {
        await abortSession("http://localhost:4096", taskSession.buildSessionId)
        aborted++
      }
      if (taskSession.testSessionId) {
        await abortSession("http://localhost:4096", taskSession.testSessionId)
        aborted++
      }
    }

    // Move busy tasks back to accepted
    const movedCount = await resetBusyTasks(config, args.plan_name)

    return `🛑 Aborted ${aborted} sessions for plan '${args.plan_name}'. Moved ${movedCount} busy tasks back to accepted.`
  },
})
