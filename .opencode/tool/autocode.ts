// .opencode/tool/autocode.ts
import { tool } from "@opencode-ai/plugin"
import {
  scanIdeas,
  scanPlans,
  findNextExecutableTasks,
  summarizeTaskTree,
  validatePlanName,
  isPlanNameUnique,
} from "../../src/core/scanner"
import {
  moveTaskStatus,
  movePlanToStage,
  archivePlan,
  createProblemLinks,
  unhideReviewMd,
  resetBusyTasks,
  deleteIdea,
} from "../../src/core/state"
import { createConfig } from "../../src/core/config"
import path from "path"

function getConfig(context: { worktree: string }) {
  return createConfig(context.worktree)
}

/**
 * Scan the .autocode/analyze/ directory for idea files.
 */
export const scan_ideas = tool({
  description:
    "Scan the .autocode/analyze/ directory and return a list of idea files with their names and content previews",
  args: {},
  async execute(_args, context) {
    const config = getConfig(context)
    const ideas = await scanIdeas(config)
    if (ideas.length === 0) {
      return "No ideas found in .autocode/analyze/. Add .md files with your ideas to get started."
    }
    return JSON.stringify(
      ideas.map((i) => ({
        name: i.name,
        path: i.path,
        preview: i.content.slice(0, 200) + (i.content.length > 200 ? "..." : ""),
        fullContent: i.content,
      })),
      null,
      2,
    )
  },
})

/**
 * Scan plans in a given stage.
 */
export const scan_plans = tool({
  description:
    "Scan autocode plans in a given stage (build, review, specs) and return their status including task counts per status directory",
  args: {
    stage: tool.schema
      .enum(["build", "review", "specs"])
      .describe("Stage to scan"),
  },
  async execute(args, context) {
    const config = getConfig(context)
    const plans = await scanPlans(config, args.stage)
    if (plans.length === 0) {
      return `No plans found in .autocode/${args.stage}/`
    }
    return JSON.stringify(
      plans.map((p) => ({
        name: p.name,
        stage: p.stage,
        hasPlanMd: !!p.planMd,
        hasReviewMd: !!p.reviewMd,
        taskSummary: summarizeTaskTree(p.tasks),
        sessionMeta: p.sessionJson
          ? {
              hasAutocodeSession: !!p.sessionJson.autocodeSessionId,
              taskCount: Object.keys(p.sessionJson.taskSessions).length,
            }
          : null,
      })),
      null,
      2,
    )
  },
})

/**
 * Find the next executable task(s) for a plan.
 */
export const next_task = tool({
  description:
    "Find the next task(s) to execute for a given plan in .autocode/build/. Returns tasks that are ready — all prerequisites (prior numbered groups) must be fully tested. Returns parallel tasks as a group when unnumbered siblings are ready. Returns status 'all_complete' when everything is done, or 'waiting' if tasks are busy.",
  args: {
    plan_name: tool.schema.string().describe("Plan directory name"),
  },
  async execute(args, context) {
    const config = getConfig(context)
    const plans = await scanPlans(config, "build")
    const plan = plans.find((p) => p.name === args.plan_name)
    if (!plan) {
      return JSON.stringify({
        status: "error",
        message: `Plan '${args.plan_name}' not found in .autocode/build/`,
      })
    }

    const nextTasks = findNextExecutableTasks(plan)

    if (nextTasks === null) {
      return JSON.stringify({
        status: "all_complete",
        message: "All tasks have been completed",
        summary: summarizeTaskTree(plan.tasks),
      })
    }

    if (nextTasks.length === 0) {
      return JSON.stringify({
        status: "waiting",
        message: "Tasks are currently busy. Waiting for completion.",
        summary: summarizeTaskTree(plan.tasks),
      })
    }

    return JSON.stringify({
      status: "ready",
      parallel: nextTasks.length > 1,
      tasks: nextTasks.map((t) => ({
        dirName: t.dirName,
        displayName: t.displayName,
        relativePath: t.relativePath,
        order: t.order,
        status: t.status,
        hasBuildPrompt: !!t.buildPrompt,
        hasTestPrompt: !!t.testPrompt,
        hasSubtasks: t.subtasks.groups.length > 0,
      })),
    })
  },
})

/**
 * Move a task between status directories.
 */
export const move_task = tool({
  description:
    "Move a task directory between status directories (accepted → busy → tested) within a plan in .autocode/build/",
  args: {
    plan_name: tool.schema.string().describe("Plan directory name"),
    task_dir_name: tool.schema
      .string()
      .describe("Task directory name (e.g., '0-setup_theme')"),
    from_status: tool.schema
      .enum(["accepted", "busy", "tested"])
      .describe("Current status directory"),
    to_status: tool.schema
      .enum(["accepted", "busy", "tested"])
      .describe("Target status directory"),
  },
  async execute(args, context) {
    const config = getConfig(context)
    try {
      await moveTaskStatus(
        config,
        args.plan_name,
        args.task_dir_name,
        args.from_status,
        args.to_status,
      )
      return `✅ Moved ${args.task_dir_name} from ${args.from_status}/ to ${args.to_status}/`
    } catch (err: any) {
      return `❌ Failed to move task: ${err.message}`
    }
  },
})

/**
 * Move a plan between stages.
 */
export const move_plan = tool({
  description:
    "Move an entire plan directory between stages (build ↔ review)",
  args: {
    plan_name: tool.schema.string().describe("Plan directory name"),
    from_stage: tool.schema
      .enum(["build", "review"])
      .describe("Current stage"),
    to_stage: tool.schema
      .enum(["build", "review"])
      .describe("Target stage"),
  },
  async execute(args, context) {
    const config = getConfig(context)
    try {
      await movePlanToStage(
        config,
        args.plan_name,
        args.from_stage,
        args.to_stage,
      )
      return `✅ Moved plan '${args.plan_name}' from ${args.from_stage}/ to ${args.to_stage}/`
    } catch (err: any) {
      return `❌ Failed to move plan: ${err.message}`
    }
  },
})

/**
 * Create problem symlinks for failed tasks.
 */
export const mark_problem = tool({
  description:
    "Create problem.prompt.md and problem.session.md symlinks pointing to the failed task's files in a plan directory",
  args: {
    plan_name: tool.schema.string().describe("Plan directory name"),
    stage: tool.schema
      .enum(["build", "review"])
      .describe("Current stage"),
    failed_prompt_path: tool.schema
      .string()
      .describe("Relative path to the failed prompt file within the plan"),
    failed_session_path: tool.schema
      .string()
      .describe("Relative path to the failed session file within the plan"),
  },
  async execute(args, context) {
    const config = getConfig(context)
    const planDir = path.join(config.rootDir, args.stage, args.plan_name)
    try {
      await createProblemLinks(
        planDir,
        args.failed_prompt_path,
        args.failed_session_path,
      )
      return `✅ Created problem symlinks in ${args.plan_name}/`
    } catch (err: any) {
      return `❌ Failed to create problem links: ${err.message}`
    }
  },
})

/**
 * Unhide the review.md file.
 */
export const unhide_review = tool({
  description:
    "Rename .review.md to review.md in a plan directory (unhide it for human review)",
  args: {
    plan_name: tool.schema.string().describe("Plan directory name"),
    stage: tool.schema
      .enum(["build", "review"])
      .describe("Current stage"),
  },
  async execute(args, context) {
    const config = getConfig(context)
    try {
      await unhideReviewMd(config, args.plan_name, args.stage)
      return `✅ Renamed .review.md to review.md in ${args.plan_name}/`
    } catch (err: any) {
      return `❌ Failed to unhide review.md: ${err.message}`
    }
  },
})

/**
 * Archive a plan after approval.
 */
export const archive_plan = tool({
  description:
    "Move a plan to .autocode/.archive/ after successful review and spec generation",
  args: {
    plan_name: tool.schema.string().describe("Plan directory name"),
    from_stage: tool.schema
      .enum(["review"])
      .describe("Current stage (must be review)"),
  },
  async execute(args, context) {
    const config = getConfig(context)
    try {
      await archivePlan(config, args.plan_name, args.from_stage)
      return `✅ Archived plan '${args.plan_name}' to .autocode/.archive/`
    } catch (err: any) {
      return `❌ Failed to archive plan: ${err.message}`
    }
  },
})

/**
 * Delete an idea file.
 */
export const delete_idea = tool({
  description:
    "Delete an idea file from .autocode/analyze/ (used after promoting an idea to a plan)",
  args: {
    idea_name: tool.schema
      .string()
      .describe("Idea name (filename without .md extension)"),
  },
  async execute(args, context) {
    const config = getConfig(context)
    try {
      await deleteIdea(config, args.idea_name)
      return `✅ Deleted idea '${args.idea_name}' from .autocode/analyze/`
    } catch (err: any) {
      return `❌ Failed to delete idea: ${err.message}`
    }
  },
})

/**
 * Full status overview.
 */
export const status = tool({
  description:
    "Get a comprehensive status overview of all autocode stages (analyze, build, review, specs)",
  args: {},
  async execute(_args, context) {
    const config = getConfig(context)
    const ideas = await scanIdeas(config)
    const buildPlans = await scanPlans(config, "build")
    const reviewPlans = await scanPlans(config, "review")

    // Count spec files
    const specsDir = path.join(config.rootDir, "specs")
    const { readdir } = await import("fs/promises")
    const specEntries = await readdir(specsDir).catch(() => [] as string[])
    const specNames = specEntries
      .filter((e) => e.endsWith(".md") && !e.startsWith("."))
      .map((e) => e.replace(/\.md$/, ""))

    return JSON.stringify(
      {
        analyze: {
          count: ideas.length,
          items: ideas.map((i) => ({
            name: i.name,
            preview: i.content.split("\n")[0]?.slice(0, 80) || "",
          })),
        },
        build: {
          count: buildPlans.length,
          items: buildPlans.map((p) => ({
            name: p.name,
            tasks: summarizeTaskTree(p.tasks),
          })),
        },
        review: {
          count: reviewPlans.length,
          items: reviewPlans.map((p) => ({
            name: p.name,
            tasks: summarizeTaskTree(p.tasks),
            hasProblem:
              p.reviewMd !== undefined &&
              p.reviewMd !== null,
          })),
        },
        specs: {
          count: specNames.length,
          items: specNames,
        },
      },
      null,
      2,
    )
  },
})

/**
 * Validate a plan name.
 */
export const validate_plan_name = tool({
  description:
    "Validate a plan name (must be lowercase, underscore-separated, max 8 words, unique against existing specs)",
  args: {
    name: tool.schema.string().describe("Proposed plan name"),
  },
  async execute(args, context) {
    const config = getConfig(context)
    const validation = validatePlanName(args.name)
    if (!validation.valid) {
      return JSON.stringify({ valid: false, error: validation.error })
    }

    const unique = await isPlanNameUnique(config, args.name)
    if (!unique) {
      return JSON.stringify({
        valid: false,
        error: `Plan name '${args.name}' conflicts with an existing spec. Choose a different name or refactor the existing spec.`,
      })
    }

    return JSON.stringify({ valid: true })
  },
})
