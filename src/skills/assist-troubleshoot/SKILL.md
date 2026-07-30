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
- Working SOLUTION supports CAUSE. Verify expected behavior and regression case.

---

## Troubleshoot Workflow

### STEP 1: Cheap EVIDENCE Discovery

1. Gather cheap read-only EVIDENCE without questioning user:
   - Read configs, env, input
   - Search logs
   - Check Git diff/history
   - Check system, fs, permissions
   - Inspect stored data
   - Trace source
2. Summarize EVIDENCE found in 1 sentence.

### STEP 2: Expensive EVIDENCE Discovery

CAUSE is clear when EVIDENCE explains SYMPTOM and no remaining plausibly refute it.

1. Skip Expensive EVIDENCE Discovery if CAUSE is clear.
2. Otherwise, each hypothesis need 1 or more follow up actions to confirm hypothesis in this preferred order (skip irrelevant/impractical actions):
   1. Similar SYMPTOMS reported online - if opensource lib is suspected
   2. Debug tests starting/calling component in isolation (cheapest, try first)
   3. Add debug logging, redeploy, reproduce (in local/test/sandbox env), view new logs
   4. Experiment: create and run stripped project copy with only suspicious components
   5. Reinstall last known working version separately and systematically reapply recent changes until broken
   6. Manual instructions - if above not autonomously possible (most expensive, last resort)
3. Report 1-4 competing CAUSE hypotheses (most likely first) as follows:
   - Numbered Heading
   - Section include numbered list simulating possible events leading to SYMPTOM based on EVIDENCE.

### STEP 3: Choose Hypotheses

1. Only 1 Hypothesis? Choose it, skip to STEP 4.
2. All Hypothesis are cheap (no Expensive EVIDENCE Discovery required)? Choose all and skip to STEP 4.
3. Otherwise, call \`question\` tool with multiple options (multi-choice):
   - \`label\`: match "Hypothesis numbered heading name".
   - \`description\`: Summarize follow-ups in < 40 words.
4. User answer = choose hypotheses to confirm/refute

### STEP 4: Confirm/Refute Hypotheses

Gather more EVIDENCE as follows:
  1. \`task\` subagents with details of chosen hypotheses, to confirm/refute chosen hypotheses, in "preferred order" according STEP 2.
  2. If "Manual instructions" are needed: use \`primary-manual\` skill to guide user how to gather EVIDENCE and wait for user feedback.

### STEP 5: Identifying ROOT CAUSE

1. According to discoveries of previous STEP:
    - List each refuted hypothesis with disproves including source refs.
    - List each confirmed hypothesis with supporting EVIDENCE including source refs.
2. No hypothesis confirmed? Repeat from Troubleshoot Workflow from STEP 1 to Report alternative Hypotheses with new discoveries.
3. Multiple hypotheses confirmed? \`question\` user with option to gather more EVIDENCE or options to choose confirmed hypothesis to assume correct.
4. Only 1 hypothesis confirmed? Continue with STEP 6.

### STEP 6: Propose APPROACHES

Report to user 1-4 APPROACH PROPOSALS in PROPOSAL REPORT to solve confirmed hypothesis and give each:
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

1. \`task\` subagents with GOAL to implement selected APPROACH and \`prompt\` must include needed known facts to avoid duplicate rediscoveries.
2. Compare \`task\` output with APPROACH description:
  - If misunderstood or missing details: \`task\` same subagent again with same \`task_id\` to clarify
  - If subagent failed because lack of tools: \`task\` another subagent to complete task
  - If new CONSTRAINT discovered making APPROACH impractical: Restart Troubleshoot Workflow from STEP 1 with new CONSTRAINT and discoveries.
  - If APPROACH SOLUTION completed successfully, continue next STEP.

### STEP 9: Report

List facts that proof original OBSTACLE is removed (APPROACH SOLUTION success)

### STEP 10: Resume Assistant Workflow

Resume Assistant Workflow to complete original todo item (ASSIGNMENT GOAL) from \`todowrite\`.
