// src/specs/skill-writer.ts
import { writeFile, mkdir } from "fs/promises"
import path from "path"

/**
 * Register a spec as an OpenCode skill under .opencode/skill/plan/<plan_name>/.
 *
 * The skill's description MUST follow this format:
 * "Use this skill to analyze the spec or requirements regarding {description}"
 *
 * Skills are prefixed with plan/ so they appear as /plan-<plan_name> commands.
 * The plan, analyze, and explore agents have access to plan-* skills.
 *
 * @param skillsDir - Path to .opencode/skill/ directory
 * @param specsDir - Path to .autocode/specs/ directory
 * @param planName - Plan name (lowercase_underscored)
 * @param specContent - Full spec markdown content
 * @param briefDescription - Short description of what the spec covers
 */
export async function registerSpecAsSkill(
  skillsDir: string,
  specsDir: string,
  planName: string,
  specContent: string,
  briefDescription: string,
): Promise<string> {
  // Skills go under .opencode/skill/plan/<plan_name>/
  const skillDir = path.join(skillsDir, "plan", planName)
  await mkdir(skillDir, { recursive: true })

  const skillPath = path.join(skillDir, "SKILL.md")

  // Escape quotes in description for YAML frontmatter
  const safeDescription = briefDescription.replace(/"/g, '\\"')

  const skillMd = `---
name: plan-${planName}
description: "Use this skill to analyze the spec or requirements regarding ${safeDescription}"
---

# Spec: ${planName.replace(/_/g, " ")}

${specContent}

## Implementation Reference

The implementation diff is available at: \`.autocode/specs/${planName}.diff\`

To see how this feature was originally implemented, review the diff file above.
This can help understand the patterns, file locations, and approaches used.
`

  await writeFile(skillPath, skillMd)
  return skillPath
}
