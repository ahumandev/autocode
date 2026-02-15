// src/core/scanner.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdir, writeFile, rm } from "fs/promises"
import path from "path"
import {
  parseTaskOrder,
  scanIdeas,
  scanPlans,
  scanTaskTree,
  findNextExecutableTasks,
  summarizeTaskTree,
  validatePlanName,
  isPlanNameUnique,
} from "./scanner"
import type { AutocodeConfig, Plan } from "./types"

const TEST_DIR = path.join(import.meta.dir, "../../.test-autocode")

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

describe("parseTaskOrder", () => {
  test("parses numbered directories", () => {
    expect(parseTaskOrder("0-setup_deps")).toEqual({ order: 0, name: "setup_deps" })
    expect(parseTaskOrder("1-create_model")).toEqual({ order: 1, name: "create_model" })
    expect(parseTaskOrder("10-final_step")).toEqual({ order: 10, name: "final_step" })
    expect(parseTaskOrder("99-last")).toEqual({ order: 99, name: "last" })
  })

  test("returns null order for unnumbered directories", () => {
    expect(parseTaskOrder("login_endpoint")).toEqual({ order: null, name: "login_endpoint" })
    expect(parseTaskOrder("toggle_ui")).toEqual({ order: null, name: "toggle_ui" })
  })

  test("handles edge cases", () => {
    expect(parseTaskOrder("0-a")).toEqual({ order: 0, name: "a" })
    expect(parseTaskOrder("100-very_long_name")).toEqual({ order: 100, name: "very_long_name" })
  })
})

describe("scanIdeas", () => {
  test("returns empty array when no ideas", async () => {
    const ideas = await scanIdeas(testConfig())
    expect(ideas).toEqual([])
  })

  test("scans markdown files", async () => {
    await writeFile(
      path.join(TEST_DIR, "analyze", "my_idea.md"),
      "# My Idea\n\nSome content",
    )
    await writeFile(
      path.join(TEST_DIR, "analyze", "another.md"),
      "# Another\n\nMore content",
    )

    const ideas = await scanIdeas(testConfig())
    expect(ideas).toHaveLength(2)
    expect(ideas.map((i) => i.name).sort()).toEqual(["another", "my_idea"])
  })

  test("ignores non-md files", async () => {
    await writeFile(path.join(TEST_DIR, "analyze", "notes.txt"), "text")
    await writeFile(path.join(TEST_DIR, "analyze", "idea.md"), "# Idea")

    const ideas = await scanIdeas(testConfig())
    expect(ideas).toHaveLength(1)
    expect(ideas[0].name).toBe("idea")
  })

  test("ignores hidden files", async () => {
    await writeFile(path.join(TEST_DIR, "analyze", ".hidden.md"), "hidden")
    await writeFile(path.join(TEST_DIR, "analyze", "visible.md"), "visible")

    const ideas = await scanIdeas(testConfig())
    expect(ideas).toHaveLength(1)
    expect(ideas[0].name).toBe("visible")
  })
})

describe("scanTaskTree — numeric sorting", () => {
  test("sorts tasks numerically, not alphabetically", async () => {
    const taskDir = path.join(TEST_DIR, "build", "test_plan", "accepted")
    
    // Create directories that would sort differently alphabetically vs numerically
    for (const name of ["0-first", "1-second", "2-third", "9-ninth", "10-tenth", "11-eleventh"]) {
      await mkdir(path.join(taskDir, name), { recursive: true })
      await writeFile(path.join(taskDir, name, "build.prompt.md"), `Build ${name}`)
    }

    const tree = await scanTaskTree(taskDir, "accepted", "")

    // Should have 6 sequential groups (each numbered task is its own group)
    expect(tree.groups).toHaveLength(6)

    // Verify numeric order: 0, 1, 2, 9, 10, 11
    const orders = tree.groups.map((g) => g[0].order)
    expect(orders).toEqual([0, 1, 2, 9, 10, 11])
  })

  test("groups unnumbered tasks as parallel", async () => {
    const taskDir = path.join(TEST_DIR, "build", "test_plan", "accepted")

    await mkdir(path.join(taskDir, "0-first"), { recursive: true })
    await writeFile(path.join(taskDir, "0-first", "build.prompt.md"), "First")

    // Unnumbered = parallel
    await mkdir(path.join(taskDir, "login"), { recursive: true })
    await writeFile(path.join(taskDir, "login", "build.prompt.md"), "Login")
    await mkdir(path.join(taskDir, "register"), { recursive: true })
    await writeFile(path.join(taskDir, "register", "build.prompt.md"), "Register")

    const tree = await scanTaskTree(taskDir, "accepted", "")

    // Group 0: [0-first], Group 1: [login, register] (parallel)
    expect(tree.groups).toHaveLength(2)
    expect(tree.groups[0]).toHaveLength(1)
    expect(tree.groups[0][0].order).toBe(0)
    expect(tree.groups[1]).toHaveLength(2)
    expect(tree.groups[1].every((t) => t.order === null)).toBe(true)
  })

  test("reads prompt files", async () => {
    const taskDir = path.join(TEST_DIR, "build", "test_plan", "accepted")
    await mkdir(path.join(taskDir, "0-setup"), { recursive: true })
    await writeFile(
      path.join(taskDir, "0-setup", "build.prompt.md"),
      "Build instructions here",
    )
    await writeFile(
      path.join(taskDir, "0-setup", "test.prompt.md"),
      "Test instructions here",
    )

    const tree = await scanTaskTree(taskDir, "accepted", "")
    expect(tree.groups[0][0].buildPrompt).toBe("Build instructions here")
    expect(tree.groups[0][0].testPrompt).toBe("Test instructions here")
  })

  test("scans subtasks recursively", async () => {
    const taskDir = path.join(TEST_DIR, "build", "test_plan", "accepted")
    const parentDir = path.join(taskDir, "1-parent")
    
    await mkdir(parentDir, { recursive: true })
    await writeFile(path.join(parentDir, "build.prompt.md"), "Parent build")
    
    // Sub-tasks
    await mkdir(path.join(parentDir, "sub_a"), { recursive: true })
    await writeFile(path.join(parentDir, "sub_a", "build.prompt.md"), "Sub A")
    await mkdir(path.join(parentDir, "sub_b"), { recursive: true })
    await writeFile(path.join(parentDir, "sub_b", "build.prompt.md"), "Sub B")

    const tree = await scanTaskTree(taskDir, "accepted", "")
    const parent = tree.groups[0][0]
    
    expect(parent.dirName).toBe("1-parent")
    expect(parent.subtasks.groups).toHaveLength(1) // One parallel group
    expect(parent.subtasks.groups[0]).toHaveLength(2) // Two parallel subtasks
  })
})

describe("validatePlanName", () => {
  test("accepts valid names", () => {
    expect(validatePlanName("add_dark_mode").valid).toBe(true)
    expect(validatePlanName("fix_auth").valid).toBe(true)
    expect(validatePlanName("refactor_api_v2").valid).toBe(true)
  })

  test("rejects uppercase", () => {
    expect(validatePlanName("Add_Dark_Mode").valid).toBe(false)
  })

  test("rejects empty", () => {
    expect(validatePlanName("").valid).toBe(false)
  })

  test("rejects special characters", () => {
    expect(validatePlanName("add-dark-mode").valid).toBe(false)
    expect(validatePlanName("add dark mode").valid).toBe(false)
  })

  test("rejects more than 8 words", () => {
    expect(
      validatePlanName("one_two_three_four_five_six_seven_eight_nine").valid,
    ).toBe(false)
  })

  test("accepts exactly 8 words", () => {
    expect(
      validatePlanName("one_two_three_four_five_six_seven_eight").valid,
    ).toBe(true)
  })
})

describe("isPlanNameUnique", () => {
  test("returns true for unique name", async () => {
    const result = await isPlanNameUnique(testConfig(), "new_feature")
    expect(result).toBe(true)
  })

  test("returns false for existing spec", async () => {
    await writeFile(
      path.join(TEST_DIR, "specs", "existing_feature.md"),
      "# Existing",
    )
    const result = await isPlanNameUnique(testConfig(), "existing_feature")
    expect(result).toBe(false)
  })
})

describe("findNextExecutableTasks", () => {
  async function createPlanWithTasks(
    statuses: Record<string, string[]>,
  ): Promise<Plan> {
    const planDir = path.join(TEST_DIR, "build", "test_plan")
    
    for (const [status, tasks] of Object.entries(statuses)) {
      for (const task of tasks) {
        const taskDir = path.join(planDir, status, task)
        await mkdir(taskDir, { recursive: true })
        await writeFile(path.join(taskDir, "build.prompt.md"), `Build ${task}`)
        await writeFile(path.join(taskDir, "test.prompt.md"), `Test ${task}`)
      }
    }

    const plans = await scanPlans(testConfig(), "build")
    return plans[0]
  }

  test("returns first group when all accepted", async () => {
    const plan = await createPlanWithTasks({
      accepted: ["0-first", "1-second", "2-third"],
      busy: [],
      tested: [],
    })

    const next = findNextExecutableTasks(plan)
    expect(next).not.toBeNull()
    expect(next!).toHaveLength(1)
    expect(next![0].dirName).toBe("0-first")
  })

  test("returns second group when first is tested", async () => {
    const plan = await createPlanWithTasks({
      accepted: ["1-second"],
      busy: [],
      tested: ["0-first"],
    })

    const next = findNextExecutableTasks(plan)
    expect(next).not.toBeNull()
    expect(next!).toHaveLength(1)
    expect(next![0].dirName).toBe("1-second")
  })

  test("returns null when all tested", async () => {
    const plan = await createPlanWithTasks({
      accepted: [],
      busy: [],
      tested: ["0-first", "1-second"],
    })

    const next = findNextExecutableTasks(plan)
    expect(next).toBeNull()
  })

  test("returns empty array when tasks are busy", async () => {
    const plan = await createPlanWithTasks({
      accepted: ["1-second"],
      busy: ["0-first"],
      tested: [],
    })

    const next = findNextExecutableTasks(plan)
    expect(next).toEqual([])
  })

  test("returns parallel tasks together", async () => {
    const plan = await createPlanWithTasks({
      accepted: ["login", "register", "logout"],
      busy: [],
      tested: [],
    })

    const next = findNextExecutableTasks(plan)
    expect(next).not.toBeNull()
    expect(next!).toHaveLength(3)
  })
})

describe("summarizeTaskTree", () => {
  test("counts tasks by status", async () => {
    const planDir = path.join(TEST_DIR, "build", "test_plan")
    
    for (const task of ["0-a", "1-b"]) {
      await mkdir(path.join(planDir, "accepted", task), { recursive: true })
      await writeFile(path.join(planDir, "accepted", task, "build.prompt.md"), "x")
    }
    await mkdir(path.join(planDir, "busy", "2-c"), { recursive: true })
    await writeFile(path.join(planDir, "busy", "2-c", "build.prompt.md"), "x")
    await mkdir(path.join(planDir, "tested", "3-d"), { recursive: true })
    await writeFile(path.join(planDir, "tested", "3-d", "build.prompt.md"), "x")

    const plans = await scanPlans(testConfig(), "build")
    const summary = summarizeTaskTree(plans[0].tasks)

    expect(summary.accepted).toBe(2)
    expect(summary.busy).toBe(1)
    expect(summary.tested).toBe(1)
    expect(summary.total).toBe(4)
  })
})
