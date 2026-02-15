// .opencode/tool/autocode-specs.ts
import { tool } from "@opencode-ai/plugin"
import { generateSpec, collectTaskSessions } from "../../src/specs/generator"
import { registerSpecAsSkill } from "../../src/specs/skill-writer"
import { readFile } from "fs/promises"
import path from "path"

/**
 * Generate a spec file, diff file, and register as an OpenCode skill.
 */
export const generate_spec = tool({
  description:
    "Generate a spec file (.md) and diff file in .autocode/specs/, then register the spec as an OpenCode skill under .opencode/skill/plan/<plan_name>/. The skill description will be: 'Use this skill to analyze the spec or requirements regarding {brief_description}'",
  args: {
    plan_name: tool.schema.string().describe("Plan name (lowercase_underscored)"),
    plan_md_content: tool.schema.string().describe("Content of plan.md"),
    brief_description: tool.schema
      .string()
      .describe(
        "Brief description of what the spec covers. Used in skill description: 'Use this skill to analyze the spec or requirements regarding {this}'",
      ),
    git_diff: tool.schema
      .string()
      .describe("Git diff output for the plan's changes (from git diff HEAD~1)"),
  },
  async execute(args, context) {
    const specsDir = path.join(context.worktree, ".autocode", "specs")
    const skillsDir = path.join(context.worktree, ".opencode", "skill")

    // Collect task sessions from the review directory
    const testedDir = path.join(
      context.worktree,
      ".autocode",
      "review",
      args.plan_name,
      "tested",
    )
    const taskSessions = await collectTaskSessions(testedDir)

    // Generate spec + diff files
    const specContent = await generateSpec(specsDir, {
      planName: args.plan_name,
      planMd: args.plan_md_content,
      taskSessions,
      gitDiff: args.git_diff,
    })

    // Register as skill
    const skillPath = await registerSpecAsSkill(
      skillsDir,
      specsDir,
      args.plan_name,
      specContent,
      args.brief_description,
    )

    return [
      `✅ Spec generated: .autocode/specs/${args.plan_name}.md`,
      `✅ Diff saved: .autocode/specs/${args.plan_name}.diff`,
      `✅ Skill registered: plan-${args.plan_name}`,
      `   Location: ${skillPath}`,
      `   Available to plan/analyze/explore agents via /plan-${args.plan_name}`,
    ].join("\n")
  },
})
