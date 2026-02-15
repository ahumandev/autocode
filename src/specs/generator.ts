// src/specs/generator.ts
import { readFile, readdir, writeFile, mkdir, stat } from "fs/promises"
import path from "path"

export interface SpecGenerationInput {
  /** Plan directory name */
  planName: string
  /** Content of plan.md */
  planMd: string
  /** Task session data for the implementation summary */
  taskSessions: Array<{
    taskName: string
    buildSession: string
    testSession?: string
  }>
  /** Git diff output for the plan's changes */
  gitDiff: string
}

/**
 * Generate a spec markdown file and diff file in .autocode/specs/.
 */
export async function generateSpec(
  specsDir: string,
  input: SpecGenerationInput,
): Promise<string> {
  await mkdir(specsDir, { recursive: true })

  const specContent = buildSpecContent(input)
  const specPath = path.join(specsDir, `${input.planName}.md`)
  const diffPath = path.join(specsDir, `${input.planName}.diff`)

  await writeFile(specPath, specContent)
  await writeFile(diffPath, input.gitDiff)

  return specContent
}

/**
 * Build the spec markdown content from plan and session data.
 */
function buildSpecContent(input: SpecGenerationInput): string {
  const title = input.planName.replace(/_/g, " ")
  let spec = `# Spec: ${title}\n\n`
  spec += `**Generated:** ${new Date().toISOString()}\n\n`

  // Overview from plan.md
  spec += `## Overview\n\n${input.planMd}\n\n`

  // Implementation summary from task sessions
  spec += `## Implementation Summary\n\n`

  for (const task of input.taskSessions) {
    const taskTitle = task.taskName.replace(/^\d+-/, "").replace(/_/g, " ")
    spec += `### ${taskTitle}\n\n`

    const buildSummary = extractSummary(task.buildSession)
    spec += `${buildSummary}\n\n`

    if (task.testSession) {
      const testSummary = extractSummary(task.testSession)
      spec += `**Test Results:** ${testSummary}\n\n`
    }
  }

  // Files changed (parsed from diff)
  spec += `## Files Changed\n\n`
  spec += `See \`${input.planName}.diff\` for the complete implementation diff.\n\n`

  const files = parseDiffFiles(input.gitDiff)
  if (files.length > 0) {
    for (const file of files) {
      spec += `- \`${file}\`\n`
    }
    spec += `\n`
  }

  return spec
}

/**
 * Extract a summary from a session markdown export.
 * Takes the last assistant response text, truncated.
 */
function extractSummary(session: string, maxLength: number = 500): string {
  // Look for the last assistant section
  const parts = session.split("## 🤖 Assistant")
  if (parts.length < 2) return "No summary available."

  const lastPart = parts[parts.length - 1]

  // Extract text content (skip tool outputs)
  const lines = lastPart.split("\n")
  const textLines: string[] = []
  let inCodeBlock = false

  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue
    if (line.startsWith("### 🔧") || line.startsWith("### ❌")) continue
    if (line.startsWith("**Input:**") || line.startsWith("**Output:**")) continue
    if (line.startsWith("---")) break
    if (line.trim()) textLines.push(line)
  }

  const text = textLines.join("\n").trim()
  return text.length > maxLength
    ? text.slice(0, maxLength) + "..."
    : text || "Implementation completed."
}

/**
 * Parse file paths from a git diff output.
 */
function parseDiffFiles(diff: string): string[] {
  const files: string[] = []
  const lines = diff.split("\n")

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/^diff --git a\/(.*) b\/(.*)$/)
      if (match) {
        files.push(match[2]) // Use the "b" path (destination)
      }
    }
  }

  return [...new Set(files)] // Deduplicate
}

/**
 * Collect task session data from a tested/ directory.
 */
export async function collectTaskSessions(
  testedDir: string,
): Promise<
  Array<{ taskName: string; buildSession: string; testSession?: string }>
> {
  const entries = await readdir(testedDir).catch(() => [] as string[])
  const sessions: Array<{
    taskName: string
    buildSession: string
    testSession?: string
  }> = []

  for (const entry of entries) {
    if (entry.startsWith(".")) continue
    const taskDir = path.join(testedDir, entry)
    const s = await stat(taskDir).catch(() => null)
    if (!s || !s.isDirectory()) continue

    const buildSession = await readFile(
      path.join(taskDir, "build.session.md"),
      "utf-8",
    ).catch(() => "No session recorded.")

    const testSession = await readFile(
      path.join(taskDir, "test.session.md"),
      "utf-8",
    ).catch(() => undefined)

    sessions.push({ taskName: entry, buildSession, testSession })
  }

  return sessions
}
