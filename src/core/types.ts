// src/core/types.ts
import { z } from "zod"

export const Stage = z.enum(["analyze", "build", "review", "specs"])
export type Stage = z.infer<typeof Stage>

export const TaskStatus = z.enum(["accepted", "busy", "tested"])
export type TaskStatus = z.infer<typeof TaskStatus>

export interface AutocodeConfig {
  /** Maximum retry attempts before escalating to review */
  retryCount: number
  /** Whether to auto-install missing dependencies on failure */
  autoInstallDependencies: boolean
  /** Maximum number of concurrent SDK sessions for parallel tasks */
  parallelSessionsLimit: number
  /** Path to the .autocode/ directory */
  rootDir: string
}

export interface Plan {
  /** Plan directory name (lowercase_underscored) */
  name: string
  /** Which stage directory the plan is in */
  stage: Stage
  /** Content of plan.md */
  planMd: string
  /** Content of .review.md or review.md */
  reviewMd?: string
  /** Parsed .session.json contents */
  sessionJson?: SessionMeta
  /** Parsed task tree from accepted/busy/tested directories */
  tasks: TaskTree
}

export interface SessionMeta {
  /** OpenCode session ID for the plan agent session */
  planSessionId?: string
  /** Session ID for the build agent (task generation) */
  buildSessionId?: string
  /** Session ID for the autocode orchestrator */
  autocodeSessionId?: string
  /** Per-task session tracking */
  taskSessions: Record<string, TaskSessionInfo>
}

export interface TaskSessionInfo {
  /** OpenCode session ID for the solve agent */
  buildSessionId?: string
  /** OpenCode session ID for the test agent */
  testSessionId?: string
  /** Number of retry attempts so far */
  retryCount: number
  /** Last error message if the task failed */
  lastError?: string
}

export interface Task {
  /** Full directory name (e.g., "0-setup_deps") */
  dirName: string
  /** Human-readable name without numeric prefix (e.g., "setup_deps") */
  displayName: string
  /** Relative path within the plan directory */
  relativePath: string
  /** Full filesystem path */
  fullPath: string
  /** Numeric order (null = parallel/unnumbered) */
  order: number | null
  /** Current status directory */
  status: TaskStatus
  /** Content of build.prompt.md (if exists) */
  buildPrompt?: string
  /** Content of test.prompt.md (if exists) */
  testPrompt?: string
  /** Content of build.session.md (after execution) */
  buildSession?: string
  /** Content of test.session.md (after execution) */
  testSession?: string
  /** Whether this task was skipped during orchestration */
  skipped?: boolean
  /** Nested subtask tree */
  subtasks: TaskTree
}

/**
 * Represents the execution order of tasks.
 *
 * Tasks are organized into sequential groups:
 * - Each group is an array of tasks that can run in PARALLEL
 * - Groups execute in ORDER (group 0 must complete before group 1 starts)
 *
 * Example: [[task0], [taskA, taskB], [task2]]
 * - First: task0 runs alone
 * - Then: taskA and taskB run concurrently
 * - Finally: task2 runs alone
 *
 * Numbered directories (e.g., "0-foo", "1-bar") create separate sequential groups.
 * Unnumbered directories (no numeric prefix) are grouped together as parallel.
 *
 * IMPORTANT: Numbered directories sort NUMERICALLY (0, 1, 2, ..., 9, 10, 11),
 * NOT alphabetically (which would sort "10" before "2").
 */
export interface TaskTree {
  /** Array of parallel groups, executed sequentially in order */
  groups: Task[][]
}

/**
 * Summary of task counts per status for display purposes.
 */
export interface TaskSummary {
  accepted: number
  busy: number
  tested: number
  total: number
}

/**
 * Result of executing a single task via the SDK.
 */
export interface TaskExecutionResult {
  /** Whether the task completed successfully */
  success: boolean
  /** OpenCode session ID used */
  sessionId: string
  /** Text output from the agent */
  output: string
  /** Error message if failed */
  error?: string
  /** Exported session as markdown */
  sessionMarkdown: string
}
