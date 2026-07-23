---
name: assist-troubleshoot
description: When task fails, use assist-troubleshoot skill, then follow its Troubleshoot Workflow to resolve OBSTACLES.
---

## Outcome Definitions

- APPROACH = changes needed to fix CAUSE and resolve SYMPTOM (like "upgrade lib to v2")
- OBSTACLE = what temporary issue prevent APPROACH from being implemented (like "recent fix caused syntax error")
- BLOCKER = what permanent issue prevent APPROACH from being implemented (like "no sudo access to upgrade library")

### Relationships

- CAUSE indicates why SYMPTOM is observed
- EVIDENCE could support or refute assumed CAUSE
- EVIDENCE is gathered by REPRODUCTION steps or research
- ERROR is a type of EVIDENCE
- TRACE shows where ERROR was observed, could help to mentally simulate CAUSE
- REPRODUCTION is only possible in ENVIRONMENT context
- APPROACH can only be designed after CAUSE was identified
- BLOCKER is obstacle that prevent APPROACH from being implemented (technical/legal/safety)
- BLOCKER is only applies when no other APPROACH is possible

### Hypothesis

- ALWAYS treat CAUSE as hypothesis until confirmed by EVIDENCE
- Consider that EVIDENCE might be misleading or coincidental
- Only working SOLUTION proof hypothesis (CAUSE) was correct

---

## Troubleshoot Workflow

### STEP 1: Report Hypotheses

DO NOT research or perform any actions yet.

Report 1-4 competing CAUSE hypotheses (most likely first) such that each hypothesis report must include:
   - Numbered Heading
   - Section include numbered list simulating possible events leading to SYMPTOM based on EVIDENCE.

### STEP 2: Define Confirmation Followups

Each reported hypothesis need 1 or more follow up actions to confirm hypothesis in this preferred order (skip irrelevant/impractical actions):

1. Check configs, env vars, input data (cheapest, try first)
2. Search keywords in logs, local or sftp remote
3. Compare Git versions, last working version - what changed?
4. Check network, fs, permission state, system resources
5. Inspect persisted data (missing, malformed, duplicated) for clues
6. Trace source code - correlate with logs if possible
7. Similar SYMPTOMS reported online - if opensource lib is suspected
8. Debug tests starting/calling component in isolation
9. Add debug logging, redeploy, reproduce (in local/test/sandbox env), view new logs
10. Experiment: create and run stripped project copy with only suspicious components
11. Reinstall last known working version separately and systematically reapply recent changes until broken
12. Manual instructions - if above not autonomously possible (most expensive, last resort)

## STEP 3: Choose Hypotheses

1. Only 1 Hypothesis? Choose it, skip to STEP 5.
2. Otherwise, call \`question\` tool with multiple options (multi-choice):
   - \`label\`: match "Hypothesis numbered heading name" matching STEP 3.
   - \`description\`: Summarize follow-ups in < 40 words from STEP 4.
3. User answer = choose hypotheses to confirm/refute (STEP 5)

### STEP 4: Confirm/Refute Hypotheses

Only after finalizing hypotheses: Now research is allowed - gather EVIDENCE as follows:
  1. \`task\` subagents with details of chosen hypotheses, to confirm/refute chosen hypotheses, in "preferred order" according STEP 2.
  2. If "Manual instructions" are needed: list sequential tutorial step with formatted examples what user must do to gather EVIDENCE and wait for user feedback.
  3. When user completed "Manual instructions", continue with STEP 6.

### STEP 5: Identifying ROOT CAUSE

Research STEP 4 is complete. No more research, instead:

1. According to discoveries of previous STEP:
    - List each refuted hypothesis with disproves including source refs.
    - List each confirmed hypothesis with supporting EVIDENCE including source refs.
2. No hypothesis confirmed? Repeat from Troubleshoot Workflow from STEP 1 to Report alternative Hypotheses with new discoveries.
4. Multiple hypotheses confirmed? \`question\` user with option to gather more EVIDENCE or options to choose confirmed hypothesis to assume correct.
5. Only 1 hypothesis confirmed? Continue with STEP 6.

### STEP 6: Design APPROACHES

Report to user 1-4 APPROACHES to solve confirmed hypothesis and give each:
   - Numbered heading name
   - Section include in Concise English:
      * numbered list of planned actions (like "update source code", "redeploy", etc.) to solve ROOT CAUSE
      * technical changes (like components affected, scripts modified, db modifications, etc.)
      * behavioral from user perspective (changes to UX, configs, performance, output)
      * warn about potential unwanted side effects of APPROACH

### STEP 7: Choose Best APPROACH

\`question\` user with options matching "Numbered heading name" of listed APPROACHES (previous STEP):
   - answer = selected APPROACH

### STEP 8: Implement APPROACH

1. \`task\` subagent \`auto_refactor\` with GOAL to implement selected APPROACH and \`prompt\` must include needed known facts to avoid duplicate rediscoveries
2. Compare \`task\` output with APPROACH description:
  - If misunderstood or missing details: \`task\` same subagent again with same \`task_id\` to clarify
  - If subagent failed because lack of tools: \`task\` another subagent to complete task
  - If new CONSTRAINT discovered making APPROACH impractical: Restart Troubleshoot Workflow from STEP 1 with new CONSTRAINT and discoveries.
  - If APPROACH SOLUTION completed successfully, continue next STEP.

### STEP 9: Report

List facts that proof original OBSTACLE is removed (APPROACH SOLUTION success)

### STEP 10: Resume Assistant Workflow

Resume Assistant Workflow to complete original todo item (ASSIGNMENT GOAL) from \`todowrite\`.
