// src/core/scanner.ts
import { readdir, readFile, stat } from "fs/promises"
import path from "path"
import type {
  Plan,
  Task,
  TaskTree,
  TaskStatus,
  TaskSummary,
  IdeaFile,
  AutocodeConfig,
  SessionMeta,
} from "./types"

/**
 * Scan the .autocode/analyze/ directory for idea markdown files.
 */
export async function scanIdeas(config: AutocodeConfig): Promise<IdeaFile[]> {
  const analyzeDir = path.join(config.rootDir, "analyze")
  const entries = await readdir(analyzeDir).catch(() => [] as string[])

  const ideas: IdeaFile[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    if (entry.startsWith(".")) continue
    const fullPath = path.join(analyzeDir, entry)
    const content = await readFile(fullPath, "utf-8")
    ideas.push({
      name: entry.replace(/\.md$/, ""),
      path: fullPath,
      content,
    })
  }
  return ideas
}

/**
 * Scan plan directories in a given stage.
 */
export async function scanPlans(
  config: AutocodeConfig,
  stage: string,
): Promise<Plan[]> {
  const stageDir = path.join(config.rootDir, stage)
  const entries = await readdir(stageDir).catch(() => [] as string[])

  const plans: Plan[] = []
  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const planDir = path.join(stageDir, entry)
    const s = await stat(planDir).catch(() => null)
    if (!s || !s.isDirectory()) continue

    const plan = await parsePlan(planDir, entry, stage as any)
    plans.push(plan)
  }
  return plans
}

/**
 * Parse a single plan directory into a Plan object.
 */
async function parsePlan(
  planDir: string,
  name: string,
  stage: string,
): Promise<Plan> {
  const planMd = await readFile(path.join(planDir, "plan.md"), "utf-8").catch(
    () => "",
  )
  const reviewMd = await readFile(
    path.join(planDir, "review.md"),
    "utf-8",
  ).catch(
    () =>
      readFile(path.join(planDir, ".review.md"), "utf-8").catch(() => undefined),
  )
  const sessionJsonRaw = await readFile(
    path.join(planDir, ".session.json"),
    "utf-8",
  ).catch(() => null)
  const sessionJson: SessionMeta | undefined = sessionJsonRaw
    ? JSON.parse(sessionJsonRaw)
    : undefined

  // Scan tasks from all three status directories
  const allTasks: Task[] = []
  for (const status of ["accepted", "busy", "tested"] as TaskStatus[]) {
    const statusDir = path.join(planDir, status)
    const tasks = await scanTasksFlat(statusDir, status, "")
    allTasks.push(...tasks)
  }

  // Build the task tree from the accepted directory (primary execution order)
  const tasks = await scanTaskTree(
    path.join(planDir, "accepted"),
    "accepted",
    "",
  )

  // Merge in busy and tested tasks for status tracking
  const busyTasks = await scanTasksFlat(
    path.join(planDir, "busy"),
    "busy",
    "",
  )
  const testedTasks = await scanTasksFlat(
    path.join(planDir, "tested"),
    "tested",
    "",
  )

  // Build a combined tree that includes all statuses
  const combinedTree = await buildCombinedTaskTree(planDir)

  return {
    name,
    stage: stage as any,
    planMd,
    reviewMd: typeof reviewMd === "string" ? reviewMd : undefined,
    sessionJson,
    tasks: combinedTree,
  }
}

/**
 * Build a combined task tree from all status directories.
 * This gives a complete view of all tasks regardless of their current status.
 */
async function buildCombinedTaskTree(planDir: string): Promise<TaskTree> {
  const allTasks: Task[] = []

  for (const status of ["accepted", "busy", "tested"] as TaskStatus[]) {
    const statusDir = path.join(planDir, status)
    const tasks = await scanTasksFlat(statusDir, status, "")
    allTasks.push(...tasks)
  }

  return organizeIntoTree(allTasks)
}

/**
 * Parse a directory name for numeric ordering.
 *
 * IMPORTANT: Sorts NUMERICALLY, not alphabetically.
 * "0-foo" → order 0, "9-bar" → order 9, "10-baz" → order 10
 * Unnumbered directories (no numeric prefix) → order null (parallel)
 */
export function parseTaskOrder(dirName: string): {
  order: number | null
  name: string
} {
  const match = dirName.match(/^(\d+)-(.+)$/)
  if (match) {
    return { order: parseInt(match[1], 10), name: match[2] }
  }
  return { order: null, name: dirName }
}

/**
 * Scan a status directory and return a flat list of tasks (non-recursive for top level).
 */
async function scanTasksFlat(
  statusDir: string,
  status: TaskStatus,
  parentPath: string,
): Promise<Task[]> {
  const entries = await readdir(statusDir).catch(() => [] as string[])
  const tasks: Task[] = []

  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const fullPath = path.join(statusDir, entry)
    const s = await stat(fullPath).catch(() => null)
    if (!s || !s.isDirectory()) continue

    const task = await parseTask(fullPath, entry, status, parentPath)
    tasks.push(task)
  }

  return tasks
}

/**
 * Scan a directory and build a TaskTree with proper ordering.
 */
export async function scanTaskTree(
  dir: string,
  status: TaskStatus,
  parentPath: string,
): Promise<TaskTree> {
  const entries = await readdir(dir).catch(() => [] as string[])

  const tasks: Task[] = []
  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const fullPath = path.join(dir, entry)
    const s = await stat(fullPath).catch(() => null)
    if (!s || !s.isDirectory()) continue

    const task = await parseTask(fullPath, entry, status, parentPath)
    tasks.push(task)
  }

  return organizeIntoTree(tasks)
}

/**
 * Organize a flat list of tasks into a TaskTree based on numeric prefixes.
 *
 * - Numbered tasks (e.g., "0-foo", "1-bar") form sequential groups
 * - Unnumbered tasks form a single parallel group
 * - Groups are sorted NUMERICALLY by their order number
 */
function organizeIntoTree(tasks: Task[]): TaskTree {
  const numbered: Map<number, Task[]> = new Map()
  const unnumbered: Task[] = []

  for (const task of tasks) {
    if (task.order !== null) {
      if (!numbered.has(task.order)) numbered.set(task.order, [])
      numbered.get(task.order)!.push(task)
    } else {
      unnumbered.push(task)
    }
  }

  // Build sequential groups — sort NUMERICALLY by order key
  const groups: Task[][] = []
  const sortedOrders = [...numbered.keys()].sort((a, b) => a - b)

  for (const order of sortedOrders) {
    groups.push(numbered.get(order)!)
  }

  // Unnumbered tasks form a single parallel group (appended after all numbered)
  if (unnumbered.length > 0) {
    groups.push(unnumbered)
  }

  return { groups }
}

/**
 * Parse a single task directory.
 */
async function parseTask(
  fullPath: string,
  dirName: string,
  status: TaskStatus,
  parentPath: string,
): Promise<Task> {
  const { order, name } = parseTaskOrder(dirName)
  const relativePath = parentPath ? `${parentPath}/${dirName}` : dirName

  const buildPrompt = await readFile(
    path.join(fullPath, "build.prompt.md"),
    "utf-8",
  ).catch(() => undefined)
  const testPrompt = await readFile(
    path.join(fullPath, "test.prompt.md"),
    "utf-8",
  ).catch(() => undefined)
  const buildSession = await readFile(
    path.join(fullPath, "build.session.md"),
    "utf-8",
  ).catch(() => undefined)
  const testSession = await readFile(
    path.join(fullPath, "test.session.md"),
    "utf-8",
  ).catch(() => undefined)
  const skipped = await stat(path.join(fullPath, ".skipped")).catch(() => null)

  // Recursively scan subtasks (subdirectories within this task)
  const subtasks = await scanTaskTree(fullPath, status, relativePath)

  return {
    dirName,
    displayName: name,
    relativePath,
    fullPath,
    order,
    status,
    buildPrompt,
    testPrompt,
    buildSession,
    testSession,
    skipped: skipped !== null,
    subtasks,
  }
}

/**
 * Find the next group of tasks ready for execution in a plan.
 *
 * Rules:
 * - Sequential groups execute in numeric order (0 before 1 before 2...)
 * - Within a group, all tasks are parallel (can run concurrently)
 * - A group is "ready" only if ALL preceding groups are fully tested
 * - Subtasks within a task must ALL complete before the parent task executes
 *
 * Returns null if all tasks are complete, or an array of parallel tasks to execute.
 */
export function findNextExecutableTasks(plan: Plan): Task[] | null {
  return findNextInTree(plan.tasks)
}

function findNextInTree(tree: TaskTree): Task[] | null {
  for (const group of tree.groups) {
    // Check if all tasks in this group are tested (or skipped)
    const allTested = group.every(
      (t) => t.status === "tested" || t.skipped,
    )

    if (allTested) {
      // This group is done, check next group
      continue
    }

    // This group has work to do. Find which tasks are ready.
    const readyTasks: Task[] = []

    for (const task of group) {
      if (task.status === "tested" || task.skipped) continue

      // Check if this task has subtasks that need to complete first
      if (task.subtasks.groups.length > 0) {
        const subtaskNext = findNextInTree(task.subtasks)
        if (subtaskNext !== null) {
          // Subtasks still need work — return those instead
          return subtaskNext
        }
        // All subtasks done — this parent task is ready
      }

      if (task.status === "accepted") {
        readyTasks.push(task)
      } else if (task.status === "busy") {
        // Task is currently being executed — don't return new tasks from this group
        // Wait for busy tasks to complete
        return []
      }
    }

    return readyTasks.length > 0 ? readyTasks : null
  }

  // All groups complete
  return null
}

/**
 * Summarize task counts for a plan.
 */
export function summarizeTaskTree(tree: TaskTree): TaskSummary {
  let accepted = 0
  let busy = 0
  let tested = 0

  function countTasks(t: TaskTree) {
    for (const group of t.groups) {
      for (const task of group) {
        switch (task.status) {
          case "accepted":
            accepted++
            break
          case "busy":
            busy++
            break
          case "tested":
            tested++
            break
        }
        // Count subtasks recursively
        countTasks(task.subtasks)
      }
    }
  }

  countTasks(tree)
  return { accepted, busy, tested, total: accepted + busy + tested }
}

/**
 * Validate a plan name.
 * - Must be lowercase
 * - Words separated by underscores
 * - No special characters except underscores
 * - Max 8 words
 */
export function validatePlanName(name: string): {
  valid: boolean
  error?: string
} {
  if (!name) return { valid: false, error: "Plan name cannot be empty" }
  if (name !== name.toLowerCase())
    return { valid: false, error: "Plan name must be lowercase" }
  if (!/^[a-z][a-z0-9_]*$/.test(name))
    return {
      valid: false,
      error:
        "Plan name must start with a letter and contain only lowercase letters, numbers, and underscores",
    }
  const words = name.split("_")
  if (words.length > 8)
    return { valid: false, error: "Plan name must be 8 words or fewer" }
  return { valid: true }
}

/**
 * Check if a plan name conflicts with existing specs.
 */
export async function isPlanNameUnique(
  config: AutocodeConfig,
  name: string,
): Promise<boolean> {
  const specsDir = path.join(config.rootDir, "specs")
  const specFile = path.join(specsDir, `${name}.md`)
  const exists = await stat(specFile).catch(() => null)
  return exists === null
}
