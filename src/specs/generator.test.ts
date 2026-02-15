// src/specs/generator.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdir, rm, readFile, writeFile } from "fs/promises"
import path from "path"
import { generateSpec, collectTaskSessions } from "./generator"

const TEST_DIR = path.join(import.meta.dir, "../../.test-autocode-specs")

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

describe("generateSpec", () => {
  test("creates spec and diff files", async () => {
    const specsDir = path.join(TEST_DIR, "specs")

    const specContent = await generateSpec(specsDir, {
      planName: "add_auth",
      planMd: "# Add Authentication\n\nImplement user auth.",
      taskSessions: [
        {
          taskName: "0-setup_deps",
          buildSession: "## 🤖 Assistant\n\nInstalled bcrypt and jsonwebtoken.",
          testSession: "## 🤖 Assistant\n\nAll packages importable. PASS.",
        },
      ],
      gitDiff:
        "diff --git a/src/auth.ts b/src/auth.ts\n+export function login() {}",
    })

    // Verify spec file
    const spec = await readFile(path.join(specsDir, "add_auth.md"), "utf-8")
    expect(spec).toContain("# Spec: add auth")
    expect(spec).toContain("## Overview")
    expect(spec).toContain("Add Authentication")
    expect(spec).toContain("## Implementation Summary")
    expect(spec).toContain("## Files Changed")
    expect(spec).toContain("`src/auth.ts`")

    // Verify diff file
    const diff = await readFile(path.join(specsDir, "add_auth.diff"), "utf-8")
    expect(diff).toContain("diff --git")
  })
})

describe("collectTaskSessions", () => {
  test("collects sessions from tested directory", async () => {
    const testedDir = path.join(TEST_DIR, "tested")
    await mkdir(path.join(testedDir, "0-task_a"), { recursive: true })
    await writeFile(
      path.join(testedDir, "0-task_a", "build.session.md"),
      "Build session A",
    )
    await writeFile(
      path.join(testedDir, "0-task_a", "test.session.md"),
      "Test session A",
    )
    await mkdir(path.join(testedDir, "1-task_b"), { recursive: true })
    await writeFile(
      path.join(testedDir, "1-task_b", "build.session.md"),
      "Build session B",
    )

    const sessions = await collectTaskSessions(testedDir)
    expect(sessions).toHaveLength(2)
    expect(sessions[0].taskName).toBe("0-task_a")
    expect(sessions[0].buildSession).toBe("Build session A")
    expect(sessions[0].testSession).toBe("Test session A")
    expect(sessions[1].taskName).toBe("1-task_b")
    expect(sessions[1].testSession).toBeUndefined()
  })
})
