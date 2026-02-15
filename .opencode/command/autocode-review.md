---
description: "Review completed autocode plans in .autocode/review/"
agent: autocode
---

## Autocode: Review Completed Plans

Use the `autocode_scan_plans` tool to scan `.autocode/review/` for plans awaiting review.

If no plans in review/, inform the user there's nothing to review.

For each plan found, present a summary including:
- Plan name
- Task summary (how many tasks succeeded/failed)
- Whether problem.prompt.md exists (indicates a failure)
- Whether review.md exists (review instructions available)

Present using the `question` tool:
- Header: "Review Plan"
- Question: "Select a plan to review, then choose an action."
- Options for the selected plan:
  - "Approve" — Commit changes, generate spec, register skill, archive
  - "Reject" — Move back to build/ for rework (will ask for feedback)
  - "View session logs" — Display task session summaries
  - "View review instructions" — Read and display review.md content
  - "View diff" — Run `git diff` to show all changes made

Handle the user's choice per the orchestration algorithm steps 6 (approval) or 7 (rejection).
