---
name: author-skill
description: How to Author Skill Files when reviewing/writing skill files for agents.
---

# Authoring Skill Files

Use this Skill Template to review/write skill files:

---

## Skill Template

```markdown
---
name: [NAME]
description: How to [ACTION] when [TRIGGER].
---

# [ACTION]

[TRIGGER]

---

[CONTENT]

---

[RULES]
```

Write Skill Template as follow:
* Replace [NAME] with short skill name as follows:
  - 4 words max
  - Prefix with `author-` for skill related to human readable content, articles
  - Prefix with `code-` for skill related to project source code, configurations, scripts
  - Prefix with `design-` for skill related to project designs (architecture)
* Replace [ACTION] with short action in Caveman English as follows:
  - Unique header summarizing action skill addresses - What knowledge and/or ability agent should expect (e.g. "Deploying Spring Boot Applications")
  - Must be < 7 words
  - Use exact phrase and case consistently
* Replace [TRIGGERS] with description of when action is relevant (< 20 words) like "Understand how to build and package Spring Boot Application for production deployments, ..."
* Replace [CONTENT] with translated content from user request into Caveman English:
  - Preferably format as structured sequence lists or bullet points
  - May include formatted examples when applicable
  - Prefer linking to templates, scripts, references, external sources instead of embedding verbose content to keep SKILL.md lean
* Replace [RULES] with important rules regarding agents behavior to apply skill:
  - Optional: Only include if behavioral changes are required
  - Must be last section SKILL.md
  - Only include very critical instructions or limitations that always apply
  - When rules contradict: Add conditions when each contradicting rule applies
* Name [TRIGGERS], [CONTENT], [RULES] sections with H2 headers (max 4 words each)

---

## Rules

- ALWAYS write skill files in `.agents/skills/{name}/SKILL.md`
- Place templates, scripts, references in subdirectories from skill directory `.agents/skills/{name}/` and link to it from `SKILL.md`, for example: `templates/email_template.html`, `scripts/process_data.py`
- Keep templates, scripts, reference files also lean (only keep important info and valuable example snippets).
- No repetitions
- Only use emojis to highlight important aspects to LLM, like attention, warning, checklists, correct vs wrong
- ALWAYS keep md < 400 lines by:
  - Cleaning up redundant content
  - Removing excessive examples
  - Summarize trivial info in [CONTENT] section
  - Only if skill's  [CONTENT] section is > 200 lines:
    1. Divide content into smaller < 200 line sections
    2. Divided skills user content should not overlap
    3. Move subdivided content to reference files (located in `.agents/skills/{name}/`) and link to it
  - As last resort: Reducing/grouping obvious instructions agent can derive by itself

___

Use this same skill text as an example on how to format other skills.
