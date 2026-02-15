// src/specs/skill-writer.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdir, rm, readFile } from "fs/promises"
import path from "path"
import { registerSpecAsSkill } from "./skill-writer"

const TEST_DIR = path.join(import.meta.dir, "../../.test-autocode-skills")

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

describe("registerSpecAsSkill", () => {
  test("creates SKILL.md under plan/ prefix", async () => {
    const skillsDir = path.join(TEST_DIR, "skills")
    const specsDir = path.join(TEST_DIR, "specs")

    const skillPath = await registerSpecAsSkill(
      skillsDir,
      specsDir,
      "add_dark_mode",
      "# Spec content\n\nDark mode implementation.",
      "dark mode toggle for the settings page",
    )

    expect(skillPath).toContain("plan/add_dark_mode/SKILL.md")

    const content = await readFile(skillPath, "utf-8")

    // Check frontmatter
    expect(content).toContain("name: plan-add_dark_mode")
    expect(content).toContain(
      'description: "Use this skill to analyze the spec or requirements regarding dark mode toggle for the settings page"',
    )

    // Check content
    expect(content).toContain("# Spec: add dark mode")
    expect(content).toContain("Dark mode implementation.")
    expect(content).toContain(".autocode/specs/add_dark_mode.diff")
  })

  test("escapes quotes in description", async () => {
    const skillsDir = path.join(TEST_DIR, "skills")
    const specsDir = path.join(TEST_DIR, "specs")

    await registerSpecAsSkill(
      skillsDir,
      specsDir,
      "test_plan",
      "content",
      'a "quoted" description',
    )

    const content = await readFile(
      path.join(skillsDir, "plan", "test_plan", "SKILL.md"),
      "utf-8",
    )
    expect(content).toContain('a \\"quoted\\" description')
  })
})
