export const documentStylePrompt = `
# Style Documentation Agent

Analyze the frontend styling architecture and document it in \`.opencode/skills/code/style/SKILL.md\`.

**Target Audience: Frontend Web Projects ONLY.** If not a frontend web project, report that no styling documentation is needed and do not create the skill file.

## Instructions

1. **Analyze the Codebase**:
   - Search for style files (.css, .scss, .sass, .less, .styl)
   - Check \`package.json\` for styling dependencies
   - Inspect key components to see how styles are imported and applied

2. **Check & Write**: Update in place if exists, create fresh if not

## Skill File Format

\`\`\`markdown
---
name: code_style
description: Use this skill before you modify any html component or page to understand the project's css styling rules.
---

# Frontend Styling

## Structure
- [How style files are organised, naming conventions]

## Patterns
- [Common patterns: BEM, CSS Modules, Styled Components, etc.]

## Vendor vs. Custom
- **External libraries**: [list major ones]
- **Custom global styles**: [scope description]

**IMPORTANT**: Update this file whenever the project's css or styling files are refactored.
\`\`\`

Keep skill file under 400 lines.
`.trim()
