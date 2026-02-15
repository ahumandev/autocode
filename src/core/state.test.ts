// src/core/state.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdir, writeFile, rm, stat, readFile, readdir } from "fs/promises"
import path from "path"
import {
  moveTaskStatus,
  movePlanToStage,
  archivePlan,
  updateSessionMeta,
  readSessionMeta,
  unhideReviewMd,
  resetBusyTasks,
  deleteIdea,
  createPlanStructure,
} from "./state"
import type { AutocodeConfig } from "./types"

const TEST_DIR = path.join(import.meta.dir, "../../.test-autocode-state")

function testConfig(): AutocodeConfig {
  return {
    retryCount: 3,
    autoInstallDependencies: true,
    parallelSessionsLimit: 4,
    rootDir: TEST_DIR,
  }
}

beforeEach(async () => {
  await mkdir(path.join(TEST_DIR, "analyze"), { recursive: true })
  await mkdir(path.join(TEST_DIR, "build"), { recursive: true })
  await mkdir(path.join(TEST_DIR, "review"), { recursive: true })
  await mkdir(path.join(TEST_DIR, "specs"), { recursive: true })
})

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

describe("moveTaskStatus", () => {
  test("moves task from accepted to busy", async () => {
    const planDir = path.join(TEST_DIR, "build", "test_plan")
    await mkdir(path.join(planDir, "accepted", "0-task"), { recursive: true })
    await writeFile(path.join(planDir, "accepted", "0-task", "build.prompt.md"), "test")

    await moveTaskStatus(testConfig(), "test_plan", "0-task", "accepted", "busy")

    const busyExists = await stat(path.join(planDir, "busy", "0-task")).catch(() => null)
    const acceptedExists = await stat(path.join(planDir, "accepted", "0-task")).catch(() => null)

    expect(busyExists).not.toBeNull()
    expect(acceptedExists).toBeNull()
  })

  test("throws on missing source", async () => {
    const planDir = path.join(TEST_DIR, "build", "test_plan")
    await mkdir(path.join(planDir, "accepted"), { recursive: true })

    expect(
      moveTaskStatus(testConfig(), "test_plan", "nonexistent", "accepted", "busy"),
    ).rejects.toThrow()
  })
})

describe("movePlanToStage", () => {
  test("moves plan from build to review", async () => {
    const planDir = path.join(TEST_DIR, "build", "my_plan")
    await mkdir(planDir, { recursive: true })
    await writeFile(path.join(planDir, "plan.md"), "test plan")

    await movePlanToStage(testConfig(), "my_plan", "build", "review")

    const reviewExists = await stat(path.join(TEST_DIR, "review", "my_plan")).catch(() => null)
    const buildExists = await stat(path.join(TEST_DIR, "build", "my_plan")).catch(() => null)

    expect(reviewExists).not.toBeNull()
    expect(buildExists).toBeNull()
  })
})

describe("archivePlan", () => {
  test("moves plan to .archive", async () => {
    const planDir = path.join(TEST_DIR, "review", "done_plan")
    await mkdir(planDir, { recursive: true })
    await writeFile(path.join(planDir, "plan.md"), "done")

    await archivePlan(testConfig(), "done_plan", "review")

    const archiveExists = await stat(path.join(TEST_DIR, ".archive", "done_plan")).catch(() => null)
    const reviewExists = await stat(path.join(TEST_DIR, "review", "done_plan")).catch(() => null)

    expect(archiveExists).not.toBeNull()
    expect(reviewExists).toBeNull()
  })
})

describe("sessionMeta", () => {
  test("reads default when no file exists", async () => {
    await mkdir(path.join(TEST_DIR, "build", "test_plan"), { recursive: true })
    const meta = await readSessionMeta(testConfig(), "test_plan", "build")
    expect(meta.taskSessions).toEqual({})
  })

  test("updates and reads session meta", async () => {
    await mkdir(path.join(TEST_DIR, "build", "test_plan"), { recursive: true })

    await updateSessionMeta(testConfig(), "test_plan", "build", (meta) => {
      meta.taskSessions["0-task"] = {
        buildSessionId: "ses_123",
        retryCount: 1,
        lastError: "test error",
      }
      return meta
    })

    const meta = await readSessionMeta(testConfig(), "test_plan", "build")
    expect(meta.taskSessions["0-task"].buildSessionId).toBe("ses_123")
    expect(meta.taskSessions["0-task"].retryCount).toBe(1)
  })
})

describe("unhideReviewMd", () => {
  test("renames .review.md to review.md", async () => {
    const planDir = path.join(TEST_DIR, "review", "test_plan")
    await mkdir(planDir, { recursive: true })
    await writeFile(path.join(planDir, ".review.md"), "review content")

    await unhideReviewMd(testConfig(), "test_plan", "review")

    const visible = await stat(path.join(planDir, "review.md")).catch(() => null)
    const hidden = await stat(path.join(planDir, ".review.md")).catch(() => null)

    expect(visible).not.toBeNull()
    expect(hidden).toBeNull()
  })
})

describe("resetBusyTasks", () => {
  test("moves all busy tasks back to accepted", async () => {
    const planDir = path.join(TEST_DIR, "build", "test_plan")
    await mkdir(path.join(planDir, "busy", "0-task_a"), { recursive: true })
    await mkdir(path.join(planDir, "busy", "1-task_b"), { recursive: true })
    await mkdir(path.join(planDir, "accepted"), { recursive: true })

    const count = await resetBusyTasks(testConfig(), "test_plan")
    expect(count).toBe(2)

    const accepted = await readdir(path.join(planDir, "accepted"))
    expect(accepted.sort()).toEqual(["0-task_a", "1-task_b"])
  })
})

describe("deleteIdea", () => {
  test("deletes idea file", async () => {
    await writeFile(path.join(TEST_DIR, "analyze", "my_idea.md"), "content")

    await deleteIdea(testConfig(), "my_idea")

    const exists = await stat(path.join(TEST_DIR, "analyze", "my_idea.md")).catch(() => null)
    expect(exists).toBeNull()
  })
})

describe("createPlanStructure", () => {
  test("creates plan directory with subdirectories", async () => {
    const planDir = await createPlanStructure(
      testConfig(),
      "new_plan",
      "# Plan\n\nContent",
      "# Review\n\nSteps",
    )

    const planMd = await readFile(path.join(planDir, "plan.md"), "utf-8")
    expect(planMd).toBe("# Plan\n\nContent")

    const reviewMd = await readFile(path.join(planDir, ".review.md"), "utf-8")
    expect(reviewMd).toBe("# Review\n\nSteps")

    const sessionJson = JSON.parse(
      await readFile(path.join(planDir, ".session.json"), "utf-8"),
    )
    expect(sessionJson.taskSessions).toEqual({})

    // Verify subdirectories exist
    for (const dir of ["accepted", "busy", "tested"]) {
      const exists = await stat(path.join(planDir, dir)).catch(() => null)
      expect(exists).not.toBeNull()
    }
  })
})
