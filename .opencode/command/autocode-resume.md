---
description: "Resume an interrupted autocode orchestration"
agent: autocode
---

## Autocode: Resume Orchestration

Use the `autocode_scan_plans` tool to scan `.autocode/build/` for plans with pending or in-progress tasks.

If no plans found in build/, also check `.autocode/review/` for plans awaiting review.

If no plans found anywhere, inform the user there's nothing to resume.

If plans are found, present them using the `question` tool:
- Header: "Select Plan"
- Question: "Which plan would you like to resume?"
- Options: One per plan, showing the plan name and task summary (accepted/busy/tested counts)

Once the user selects a plan, begin the orchestration algorithm:
1. Scan for next executable tasks
2. Execute tasks (build then test for each)
3. Handle failures with auto-recovery and retries
4. On completion or exhausted retries, question user for next steps
