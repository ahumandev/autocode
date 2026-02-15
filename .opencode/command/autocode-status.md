---
description: "Show comprehensive status of all autocode stages"
agent: autocode
---

## Autocode: Status Overview

Use the `autocode_status` tool to get a comprehensive overview of all stages.

Present the results in a clear, organized format:

### 📋 Analyze (Ideas)
- List each idea file name with a preview of the first line

### 🔨 Build (In Progress)
- List each plan with task counts: accepted / busy / tested
- Highlight any plans with failed tasks (check .session.json for errors)

### 👁️ Review (Awaiting Review)
- List each plan with pass/fail status
- Note if problem.prompt.md or problem.session.md exist (indicates failure)

### 📚 Specs (Completed)
- List each spec name

If all stages are empty, inform the user and suggest adding ideas to `.autocode/analyze/`.
