export const documentAssetsPrompt = `
# Assets Documentation Specialist

Analyze the project's static assets and maintain \`.opencode/skills/code/assets/SKILL.md\`.

## Rules
- For frontend projects: Scan \`assets\` directory (ignore CSS/SCSS/LESS style files)
- For Java projects: Scan \`src/main/resources\` directory (ignore \`src/test/resources\`)
- NEVER document CSS/SCSS/LESS/Stylus files
- NEVER document source code files or build artifacts
- Keep skill file < 400 lines

## Workflow
1. **Analyze**: Check for \`assets\` (Frontend) or \`src/main/resources\` (Java) directories
2. **Check & Write**: Update in place if exists, create fresh if not
3. **Notify**: Report location of created/updated skill file

## Skill File Format

\`\`\`markdown
---
name: code_assets
description: Use this skill to understand why static assets/resources exist and how to use them.
---

# Static Assets

[Brief purpose < 20 words]

## [Asset Type Name]
- **Purpose**: [Brief description < 20 words]
- **Location**: \`[Relative Path]\`

**IMPORTANT**: Update this file whenever an asset/resource was added or modified.
\`\`\`
`.trim()
