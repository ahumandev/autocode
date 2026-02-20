// src/setup.ts
import { mkdir, writeFile, stat } from "fs/promises"
import path from "path"

/**
 * Initialize the .autocode/ directory structure in a project.
 * Creates all stage directories and a sample idea.
 *
 * @param projectRoot - The project root directory
 */
export async function initAutocode(projectRoot: string, verbose = false): Promise<void> {
  const autocodeDir = path.join(projectRoot, ".autocode")

  // Check if already initialized
  const existing = await stat(autocodeDir).catch(() => null)
  if (existing && verbose) {
    console.log("⚠️  .autocode/ directory already exists at", autocodeDir)
    console.log("   Ensuring all subdirectories exist...")
  }

  // Create stage directories
  const dirs = ["analyze", "build", "review", "specs", ".archive"]

  for (const dir of dirs) {
    await mkdir(path.join(autocodeDir, dir), { recursive: true })
  }

  // Create .gitkeep files to preserve empty directories in git
  for (const dir of dirs) {
    const gitkeepPath = path.join(autocodeDir, dir, ".gitkeep")
    const gitkeepExists = await stat(gitkeepPath).catch(() => null)
    if (!gitkeepExists) {
      await writeFile(gitkeepPath, "")
    }
  }


  // Create README
  const readmePath = path.join(autocodeDir, "README.md")
  const readmeExists = await stat(readmePath).catch(() => null)
  if (!readmeExists) {
    await writeFile(
      readmePath,
      `# Autocode Workflow

## Stages

- \`analyze/\` — Add your idea .md files here
- \`build/\` — Plans being converted to tasks and executed
- \`review/\` — Completed plans awaiting your review
- \`specs/\` — Approved specs (also registered as OpenCode skills under /plan-*)
- \`.archive/\` — Historical plan directories

## Commands

- \`/autocode-analyze\` — Pick an idea and start planning
- \`/autocode-resume\` — Resume an interrupted build
- \`/autocode-review\` — Review completed plans
- \`/autocode-status\` — Show status of all stages
- \`/autocode-abort\` — Emergency abort all running tasks
- \`/autocode-init\` — Initialize this directory structure

## Quick Start

1. Add an idea file to \`.autocode/analyze/\` (e.g., \`my_feature.md\`)
2. Run \`/autocode-analyze\` in OpenCode
3. Plan interactively with the plan agent + Planatator
4. Approve the plan → build agent generates task structure
5. Autocode orchestrator executes tasks → come back when done
6. Run \`/autocode-review\` to approve or reject results

## Directory Structure

\`\`\`
.autocode/
├── analyze/          # Ideas (user-created .md files)
├── build/            # Active plans with task directories
│   └── plan_name/
│       ├── plan.md
│       ├── .review.md
│       ├── .session.json
│       ├── accepted/   # Tasks not yet started
│       ├── busy/       # Tasks currently executing
│       └── tested/     # Tasks completed & verified
├── review/           # Plans awaiting manual review
├── specs/            # Approved specs (.md + .diff files)
└── .archive/         # Archived plan directories
\`\`\`
`,
    )
  }

  // Create a sample idea (only if analyze/ is empty)
  const analyzeDir = path.join(autocodeDir, "analyze")
  const analyzeEntries = await import("fs/promises").then((fs) =>
    fs.readdir(analyzeDir),
  )
  const hasMdFiles = analyzeEntries.some(
    (e) => e.endsWith(".md") && !e.startsWith("."),
  )

  if (!hasMdFiles) {
    await writeFile(
      path.join(analyzeDir, "example_idea.md"),
      `# Example Idea: Add Health Check Endpoint

## What
Add a /health endpoint that returns server status, uptime, and dependency health.

## Why
Needed for monitoring and load balancer health checks.

## Acceptance Criteria
- GET /health returns 200 with JSON body
- Response includes: status, uptime, version, dependencies (db, cache)
- Response time < 100ms
- Works without authentication
`,
    )
  }

  if (verbose) {
    console.log("✅ Autocode initialized at", autocodeDir)
    console.log("")
    console.log("Next steps:")
    console.log("  1. Add idea .md files to .autocode/analyze/")
    console.log("  2. Run /autocode-analyze in OpenCode to start planning")
  }
}

// Allow running directly: bun run src/setup.ts [projectRoot]
if (import.meta.main) {
  const projectRoot = process.argv[2] || process.cwd()
  initAutocode(projectRoot, true).catch((err) => {
    console.error("Failed to initialize autocode:", err)
    process.exit(1)
  })
}
