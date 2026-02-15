---
description: "Scan ideas in .autocode/analyze/ and start planning one with the plan agent"
agent: build
---

## Autocode: Analyze Ideas

Use the `autocode_scan_ideas` tool to scan the `.autocode/analyze/` directory for idea files.

If no ideas are found, inform the user that the `.autocode/analyze/` directory is empty and they should add `.md` files with their ideas there.

If ideas are found, present them to the user using the `question` tool:
- Header: "Select an Idea"
- Question: "Which idea would you like to develop into a plan?"
- Options: One option per idea file, using the idea name as the label and the first ~100 characters of content as the description

Once the user selects an idea:
1. Read the full content of the selected idea file using the scan results
2. Delete the idea file from `.autocode/analyze/` using the `autocode_delete_idea` tool (it's being promoted to a plan)
3. Use the `plan_enter` tool to switch to the plan agent
4. Inject the idea content as context for the plan agent to analyze and develop into a structured plan
