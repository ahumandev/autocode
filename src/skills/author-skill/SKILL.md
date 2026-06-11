---
name: author-skill
description: Use `author-rules` to get Skill File Authoring when you need to review/write skill files for agents.
---

# Skill File Authoring

Use this Skill Template to review/write skill files:

---

## Skill Template 

Write skill Template:

```markdown
---
name: [NAME]
description: Use `[NAME]` to get [TOPIC] if [CONDITION].
---

# [TOPIC]

[TRIGGERS]

---

[CONTENT]

---

[RULES]
```

Replace above [PLACEHOLDERS] in Layout Template with:

* Replace [NAME] with short skill name as follows:
  - 4 words max
  - Prefix with `author-` for skill related to human readable content, articles
  - Prefix with `code-` for skill related to project source code, configurations, scripts
  - Prefix with `design-` for skill related to project designs (architecture)
* [TOPIC] with short topic in Caveman English as follows:
  - Unique header summarizing topic skill addresses - What knowledge and/or ability agent should expect (e.g. "Deploying Spring Boot Applications")
  - Must be < 7 words
  - Use exact phrase and case consistently
* [TRIGGERS] with description of when topic is relevant (< 20 words) like "Understand how to build and package Spring Boot Application for production deployments, ..."
* [CONTENT] translate content from user request into Caveman English:
  - Preferably format as structured sequence lists or bullet points
  - May include formatted examples when applicable
  - Prefer linking to templates, scripts, references, external sources instead of embedding verbose content to keep SKILL.md lean
* [RULES] important rules regarding agents behavior to apply skill:
  - Optional: Only include if behavioral changes are required
  - Must be last section SKILL.md
  - Only include very critical instructions or limitations that always apply
  - When rules contradict: Add conditions when each contradicting rule applies

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
