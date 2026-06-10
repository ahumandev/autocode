---
name: author-rules
description: Use `author-rules` get Agent Rule Format when reviewing/writing agent prompts, commands or AGENTS.md
---

# Agent Rule Format

When writing agent prompts, commands or AGENTS.md apply this layout:

## Layout 

Layout Template:

```
# [TITLE]

[PURPOSE]

[USER REQUEST ANALYSIS]

[WORKFLOW]

[CONDITIONAL INSTRUCTIONS]

[USER CONTENT]

[RULES]
```

Replace above [PLACEHOLDERS] in Layout Template with:

[TITLE]
- Unique description of rules file
- Must be < 7 words
- Type of rule file determine title:
  - Agent prompt: [TITLE] = Agent role (e.g. "Java Coder")
  - Skill: [TITLE] = What knowledge and/or ability agent should expect (e.g. "Spring Boot Applications")
  - AGENTS.md: [TITLE] = Scope of instructions (e.g. Project name for root AGENTS.md "Autocode Plugin" or Package purpose for sub AGENTS.md like "Business Services")

[PURPOSE]
- Agent prompt + multiple AGENTS.md files + skill files will be concatenated into 1 system prompt which may confuse agent about when to apply which rules
- Solution: Define purpose for rule set such that agent understands when or how to apply rules
- Must be < 20 words
- Type of rule file determine title:
  - Agent prompts: [PURPOSE] = High-level responsibilities of agent (e.g. "You write professional Java Code...")
  - Skill: [PURPOSE] = Conditions when rules become relevant (e.g. "When designing Spring Boot Application...")
  - AGENTS.md: [PURPOSE] = What content to find in scope AGENTS.md file covers: root AGENTS.md summarize purpose of entire project; sub AGENTS.md summarize purpose of sub-scope

[USER REQUEST ANALYSIS]
- Only include [USER REQUEST ANALYSIS] for agent prompts or commands
- Defining "user request":
  - commands: "user request" = existing session context
  - agent prompts: "user request" = user's original prompt

1. This section must first indicate how to categorize each type of supported "user request" in < 20 words per category
2. Then this section must map each category to workflow/conditional instructions and/or any special rules that may apply for that condition in < 40 words per category

- [USER REQUEST ANALYSIS] must also indicate how to handle unsupported "user requests" in < 20 words
- Omit [USER REQUEST ANALYSIS] section entirely if all user request should be treated the same

[CONDITIONAL INSTRUCTIONS]
- Conditional Instructions may be 1 or more primary sections
- Unlike Workflows that contain fixed sequential steps, conditional instructions apply ad-hoc based on conditions
- Typical examples:
    - Interviewing User
    - Handling Errors
    - Presenting Report
- Each Conditional Instruction section must start with condition: when to apply instructions
- Numeric list of sequential instructions agent must follow
- Keep instructions concise but understandable in < 40 words per instruction
- Large (40+ lines) or complex [CONDITIONAL INSTRUCTIONS] should be moved to separate skills or references/ folders to be loaded ad-hoc

[USER CONTENT]
- Omit entire [USER CONTENT] section by default, unless user specified additional content
- Format content according to user request
- May span across multiple primary sections
- May include examples
- Preferably keep write content as concise bullet points (unless user specified different format)

[RULES]
- Must be section final in md file
- Only include very critical (dangerous consequence if not adhered - e.g. forbidden actions/limiting scope) rules or common rules that always applies (edge-cases belong in [CONDITIONAL INSTRUCTIONS] section)
- When rules contradict: Add conditions when each contradicting rule applies
- Must be < 40 words per rule (excluding conditions)

[WORKFLOW]
- Only include [WORKFLOW] section if rules contain sequential instructions (steps)
- It usually follows default happy path to accomplish specific purpose of agent
- ALWAYS omit entire [WORKFLOW] section for AGENTS.md (too general)

Workflow Template:

```

---

## Workflow

[WORKFLOW TOC]

### STEP 1: [STEP TITLE]

[STEP GOAL]

[STEP INSTRUCTIONS]

[STEP EXAMPLE]

### Step 2...

---

```

Line dividers (`---`) helps to organize large Workflow with its steps together

Replace above [PLACEHOLDERS] in Workflow Template with:

[WORKFLOW TOC]
Include every step section's header without "STEP X: " prefixes in same order steps appear

For example:

```md

---

## Workflow

1. Analyze Problem
2. Solve Problem
3. Test Solution

### STEP 1: Analyze Problem
...

### STEP 2: Solve Problem
...

### STEP 3: Test Solution
...

---

```

[STEP GOAL]

Briefly describe goal of specific STEP in < 20 words

[STEP INSTRUCTIONS]

- Numeric list of sequential step instructions agent must follow
- Keep instructions concise but understandable in < 40 words per instruction

[STEP EXAMPLE]

- Only include examples for complex STEPS or specific templates
- User provided examples MUST be keep as-is (no stripping, reducing, formatting or any other modifications allowed)
- Keep generated examples minimalistic but understandable to limited LLM
- Generate max 1 good example per step (if no user example was provided)
- Generate only bad examples if common pitfalls are expected that should be avoided
- Never generate examples for obvious steps
- When writing skills: Extract large examples/templates (> 40 lines) to template files (located in `.agents/skills/{skill-name}/templates/`) with references to `templates/{template-file}` in original skill

## Rules

- ALWAYS speak and write Caveman English
- Each point < 20 words
- No repetitions
- Only use emojis to highlight important aspects to LLM, like attention, warning, checklists, correct vs wrong
- Always keep md < 400 lines by:
  - Cleaning up redundant content
  - Removing excessive examples
  - Only if skill's [USER CONTENT] section is > 200 lines:
    1. Divide content into smaller < 200 line sections
    2. Divided skills user content should not overlap
    3. Move subdivided content to reference files (located in `.agents/skills/{skill-name}/references/`)
    4. Refer to `reference/{reference-name}` references in original `SKILL.md` with instruction when load which reference
    5. Report list of skill files you created to user
  - Otherwise summarize trivial info in [USER CONTENT] section
  - As last resort: Reducing/grouping obvious instructions agent can derive by itself
