// src/core/state.ts
import { rename, mkdir, symlink, readFile, writeFile, readdir, stat, unlink } from "fs/promises"
import path from "path"
import type { AutocodeConfig, SessionMeta } from "./types"

/**
 * Move a task directory between status directories within a plan.
 * e.g., accepted/0-setup_deps → busy/0-setup_deps
 */
export async function moveTaskStatus(
  config: AutocodeConfig,
  planName: string,
  taskDirName: string,
  fromStatus: string,
  toStatus: string,
): Promise<void> {
  const planDir = path.join(config.rootDir, "build", planName)
  const from = path.join(planDir, fromStatus, taskDirName)
  const to = path.join(planDir, toStatus, taskDirName)

  // Ensure target status directory exists
  await mkdir(path.join(planDir, toStatus), { recursive: true })

  // Verify source exists
  const s = await stat(from).catch(() => null)
  if (!s) {
    throw new Error(
      `Task directory not found: ${fromStatus}/${taskDirName} in plan ${planName}`,
    )
  }

  await rename(from, to)
}

/**
 * Move an entire plan directory between stages.
 * e.g., build/add_dark_mode → review/add_dark_mode
 */
export async function movePlanToStage(
  config: AutocodeConfig,
  planName: string,
  fromStage: string,
  toStage: string,
): Promise<void> {
  const from = path.join(config.rootDir, fromStage, planName)
  const to = path.join(config.rootDir, toStage, planName)

  // Ensure target stage directory exists
  await mkdir(path.join(config.rootDir, toStage), { recursive: true })

  // Verify source exists
  const s = await stat(from).catch(() => null)
  if (!s) {
    throw new Error(
      `Plan directory not found: ${fromStage}/${planName}`,
    )
  }

  await rename(from, to)
}

/**
 * Create problem.prompt.md and problem.session.md symlinks
 * pointing to the failed task's files.
 */
export async function createProblemLinks(
  planDir: string,
  failedPromptPath: string,
  failedSessionPath: string,
): Promise<void> {
  const problemPrompt = path.join(planDir, "problem.prompt.md")
  const problemSession = path.join(planDir, "problem.session.md")

  // Remove existing symlinks if they exist
  await unlink(problemPrompt).catch(() => {})
  await unlink(problemSession).catch(() => {})

  // Create new symlinks
  await symlink(failedPromptPath, problemPrompt).catch((err) => {
    console.error(`Failed to create problem prompt symlink: ${err.message}`)
  })
  await symlink(failedSessionPath, problemSession).catch((err) => {
    console.error(`Failed to create problem session symlink: ${err.message}`)
  })
}

/**
 * Read and update the .session.json metadata file for a plan.
 */
export async function updateSessionMeta(
  config: AutocodeConfig,
  planName: string,
  stage: string,
  updater: (meta: SessionMeta) => SessionMeta,
): Promise<void> {
  const metaPath = path.join(
    config.rootDir,
    stage,
    planName,
    ".session.json",
  )

  const existing = await readFile(metaPath, "utf-8").catch(
    () => '{"taskSessions":{}}',
  )

  let meta: SessionMeta
  try {
    meta = JSON.parse(existing)
  } catch {
    meta = { taskSessions: {} }
  }

  const updated = updater(meta)
  await writeFile(metaPath, JSON.stringify(updated, null, 2))
}

/**
 * Read the .session.json metadata file for a plan.
 */
export async function readSessionMeta(
  config: AutocodeConfig,
  planName: string,
  stage: string,
): Promise<SessionMeta> {
  const metaPath = path.join(
    config.rootDir,
    stage,
    planName,
    ".session.json",
  )

  const raw = await readFile(metaPath, "utf-8").catch(
    () => '{"taskSessions":{}}',
  )

  try {
    return JSON.parse(raw)
  } catch {
    return { taskSessions: {} }
  }
}

/**
 * Archive a plan by moving it to .autocode/.archive/
 */
export async function archivePlan(
  config: AutocodeConfig,
  planName: string,
  fromStage: string,
): Promise<void> {
  const from = path.join(config.rootDir, fromStage, planName)
  const archiveDir = path.join(config.rootDir, ".archive")
  const to = path.join(archiveDir, planName)

  await mkdir(archiveDir, { recursive: true })

  // Verify source exists
  const s = await stat(from).catch(() => null)
  if (!s) {
    throw new Error(
      `Plan directory not found: ${fromStage}/${planName}`,
    )
  }

  await rename(from, to)
}

/**
 * Rename .review.md to review.md (unhide it for human review).
 */
export async function unhideReviewMd(
  config: AutocodeConfig,
  planName: string,
  stage: string,
): Promise<void> {
  const planDir = path.join(config.rootDir, stage, planName)
  const hidden = path.join(planDir, ".review.md")
  const visible = path.join(planDir, "review.md")

  const exists = await stat(hidden).catch(() => null)
  if (exists) {
    await rename(hidden, visible)
  }
}

/**
 * Move all busy tasks back to accepted (used during abort).
 */
export async function resetBusyTasks(
  config: AutocodeConfig,
  planName: string,
): Promise<number> {
  const busyDir = path.join(config.rootDir, "build", planName, "busy")
  const acceptedDir = path.join(
    config.rootDir,
    "build",
    planName,
    "accepted",
  )

  await mkdir(acceptedDir, { recursive: true })

  const entries = await readdir(busyDir).catch(() => [] as string[])
  let moved = 0

  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const s = await stat(path.join(busyDir, entry)).catch(() => null)
    if (!s || !s.isDirectory()) continue

    await rename(
      path.join(busyDir, entry),
      path.join(acceptedDir, entry),
    )
    moved++
  }

  return moved
}

/**
 * Delete an idea file from the analyze directory.
 */
export async function deleteIdea(
  config: AutocodeConfig,
  ideaName: string,
): Promise<void> {
  const ideaPath = path.join(config.rootDir, "analyze", `${ideaName}.md`)
  await unlink(ideaPath)
}

/**
 * Create the initial plan directory structure in build/.
 */
export async function createPlanStructure(
  config: AutocodeConfig,
  planName: string,
  planMdContent: string,
  reviewMdContent: string,
): Promise<string> {
  const planDir = path.join(config.rootDir, "build", planName)

  await mkdir(path.join(planDir, "accepted"), { recursive: true })
  await mkdir(path.join(planDir, "busy"), { recursive: true })
  await mkdir(path.join(planDir, "tested"), { recursive: true })

  await writeFile(path.join(planDir, "plan.md"), planMdContent)
  await writeFile(path.join(planDir, ".review.md"), reviewMdContent)
  await writeFile(
    path.join(planDir, ".session.json"),
    JSON.stringify({ taskSessions: {} }, null, 2),
  )

  return planDir
}
