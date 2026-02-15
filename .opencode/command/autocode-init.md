---
description: "Initialize the .autocode/ directory structure in the current project"
agent: build
---

## Autocode: Initialize

Initialize the autocode workflow directory structure by running:

```bash
cd {worktree} && bun run src/setup.ts
```

If the setup script is not found (this project may not have autocode installed), create the directories manually:

```bash
mkdir -p .autocode/analyze .autocode/build .autocode/review .autocode/specs .autocode/.archive
mkdir -p .opencode/skill/plan
```

After initialization, report the created directory structure and explain the workflow:
1. Add idea .md files to `.autocode/analyze/`
2. Run `/autocode-analyze` to start planning
3. Plan interactively with the plan agent
4. Build agent generates task structure
5. Autocode orchestrator executes tasks
6. Run `/autocode-review` to approve or reject
