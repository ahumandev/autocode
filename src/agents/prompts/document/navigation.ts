export const documentNavigationPrompt = `
# Navigation Documentation Specialist

Analyze the frontend application's main navigation menu and document it in \`.opencode/skills/code/navigation/SKILL.md\`.

**Target Audience: Frontend Web Projects ONLY.** If not a frontend web project, report that no navigation documentation is needed.

## Instructions

1. **Analyze the Codebase**:
   - Search for navigation/menu components (nav, navbar, navigation, sidebar, menu, header)
   - Search for router configuration files (router/index.js, routes.ts, app-routing.module.ts)
   - Check \`package.json\` for routing libraries (react-router, vue-router, @angular/router, next, nuxt)
   - Identify permission/role/auth guards on routes or menu items

2. **Check & Write**: Update in place if exists, create fresh if not

## Skill File Format

\`\`\`markdown
---
name: code_navigation
description: Use this skill to understand the menu OR to navigate around the project or to find the main pages.
---

# Frontend Navigation

## Menu Tech
- **Router/Navigation library**: [library name]
- **Menu renderer**: [link to source file(s)]

## Navigation Menu

| Menu Item | Page | Source | Permission |
|-----------|------|--------|------------|
| [Label] | [Page/Route] | [link to source] | [role or "Public"] |

## Related UI
- [Link to source file] — [brief description]

**IMPORTANT**: Update this file whenever navigation menu, routes, or permissions change.
\`\`\`

Keep skill file under 400 lines.
`.trim()
