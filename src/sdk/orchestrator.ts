// src/sdk/orchestrator.ts
import type { TaskExecutionResult } from "../core/types"

export interface TaskExecution {
  /** Plan directory name */
  planName: string
  /** Task path for logging */
  taskPath: string
  /** Full prompt content to send to the agent */
  promptContent: string
  /** Which agent to use */
  agent: "solve" | "test"
  /** Existing session ID for resuming */
  sessionId?: string
}

/**
 * Execute a single task by spawning a headless OpenCode session.
 * 
 * Creates a new session (or resumes an existing one), sends the prompt
 * to the specified agent, waits for completion, and exports the session.
 */
export async function executeTask(
  baseUrl: string,
  task: TaskExecution,
): Promise<TaskExecutionResult> {
  const { createOpencodeClient } = await import("@opencode-ai/sdk")
  const client = createOpencodeClient({ baseUrl })

  // Create or resume session
  let sessionId = task.sessionId
  if (!sessionId) {
    const session = await client.session.create({
      body: { title: `autocode: ${task.agent} — ${task.taskPath}` },
    })
    sessionId = session.data?.id
    if (!sessionId) {
      throw new Error("Failed to create session — no ID returned")
    }
  }

  try {
    // Send prompt to specified agent
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        agent: task.agent,
        parts: [{ type: "text", text: task.promptContent }],
      },
    })

    // Wait for completion via event stream
    const result = await waitForCompletion(client, sessionId)

    // Export session to markdown
    const { exportSessionToMarkdown } = await import("./session-exporter")
    const markdown = await exportSessionToMarkdown(client, sessionId)

    return {
      success: !result.error,
      sessionId,
      output: result.output,
      error: result.error,
      sessionMarkdown: markdown,
    }
  } catch (err: any) {
    const { exportSessionToMarkdown } = await import("./session-exporter")
    const markdown = await exportSessionToMarkdown(client, sessionId).catch(
      () => `# Session Export Failed\n\nError: ${err.message}`,
    )

    return {
      success: false,
      sessionId,
      output: "",
      error: err.message || String(err),
      sessionMarkdown: markdown,
    }
  }
}

/**
 * Execute multiple tasks concurrently via separate SDK sessions.
 * 
 * Each task gets its own session. Respects concurrency limit.
 * Used for PARALLEL (unnumbered) sibling tasks.
 * Each task still runs solve→test sequentially within itself.
 */
export async function executeParallelTasks(
  baseUrl: string,
  tasks: TaskExecution[],
  limit: number,
): Promise<TaskExecutionResult[]> {
  const results: TaskExecutionResult[] = new Array(tasks.length)
  const executing: Set<Promise<void>> = new Set()

  for (let i = 0; i < tasks.length; i++) {
    const index = i
    const promise = (async () => {
      results[index] = await executeTask(baseUrl, tasks[index])
    })()

    executing.add(promise)
    promise.finally(() => executing.delete(promise))

    // Respect concurrency limit
    if (executing.size >= limit) {
      await Promise.race(executing)
    }
  }

  // Wait for all remaining
  await Promise.all(executing)
  return results
}

/**
 * Abort a running session.
 */
export async function abortSession(
  baseUrl: string,
  sessionId: string,
): Promise<void> {
  const { createOpencodeClient } = await import("@opencode-ai/sdk")
  const client = createOpencodeClient({ baseUrl })
  await client.session.abort({ path: { id: sessionId } }).catch(() => {
    // Session may already be complete or not exist
  })
}

/**
 * Wait for a session to reach idle status by monitoring the event stream.
 */
async function waitForCompletion(
  client: any,
  sessionId: string,
  timeoutMs: number = 600_000, // 10 minute default timeout
): Promise<{ output: string; error?: string }> {
  let output = ""
  let error: string | undefined

  // Use a timeout to prevent hanging forever
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Session ${sessionId} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })

  const completionPromise = (async () => {
    try {
      const events = await client.event.subscribe()

      for await (const event of events.stream) {
        // Track text output
        if (
          event.type === "message.part.updated" &&
          event.properties?.part?.sessionID === sessionId
        ) {
          const part = event.properties.part
          if (part.type === "text" && part.text) {
            output = part.text // Replace with latest (parts are cumulative)
          }
          if (part.type === "tool" && part.state?.status === "error") {
            error = part.state.error
          }
        }

        // Detect completion
        if (
          event.type === "session.status" &&
          event.properties?.sessionID === sessionId &&
          event.properties?.status?.type === "idle"
        ) {
          break
        }
      }
    } catch (err: any) {
      if (!error) error = err.message
    }

    return { output, error }
  })()

  return Promise.race([completionPromise, timeoutPromise])
}
