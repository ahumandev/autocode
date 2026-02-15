---
description: "Emergency abort: immediately stop all running autocode tasks"
agent: autocode
---

## Autocode: Emergency Abort

This is an EMERGENCY command. Act quickly.

Use the `autocode_scan_plans` tool to find plans in `.autocode/build/` that have busy tasks (check task summary for busy count > 0).

If no busy tasks found, inform the user there's nothing to abort.

If busy plans found, present them using the `question` tool:
- Header: "Abort Running Tasks"
- Question: "Which plan should be aborted? All running sessions will be terminated immediately and busy tasks moved back to accepted."
- Options:
  - One option per plan with busy tasks, showing the plan name and busy task count
  - "Abort ALL plans" option if multiple plans have busy tasks

Once confirmed, use `autocode-sdk_abort_plan_sessions` for the selected plan(s) to:
1. Abort all running SDK sessions immediately
2. Move all busy tasks back to accepted status

Report what was aborted: number of sessions killed and tasks reset.

Do NOT ask for additional confirmation — this is an emergency command. Execute as soon as the user selects a plan.
