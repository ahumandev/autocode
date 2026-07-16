---
name: author-skill
description: Use author-skill when writing/reviewing skill files (SKILL.md) or to improve agent context.
---

Template:

```markdown
---
name: [NAME]
description: Use [NAME] when [CONDITION].
---

[CONTENT]
```

Write Skill Template as follow:

* Replace [NAME] with short skill name as follows:
  - 4 words max
  - Prefix with `author-` for skill related to human readable content, articles
  - Prefix with `code-` for skill related to project source code, configurations, scripts
  - Prefix with `design-` for skill related to project designs (architecture)
  - Skill names are always snake-case and contain only alpha-numeric characters and `-` (minus).
* Replace [CONDITION] with trigger when skill becomes relevant:
  - ⚠️ CRITICAL: description is ONLY text LLM reads to decide load skill. Bad description = skill never triggers.
  - Start with purpose (verb + object): what skill does.
  - Add trigger conditions: when skill relevant (benefit + technical triggers).
  - May optionally include exceptions.
  - If [CONDITION] complex add few examples to illustrate.
  - Use MINIMAL Caveman English words to avoid context rot (max 100 words).
  - Examples:
    - ✅ Good: `Use git-commit when creating Git commit message for recent changes.`
    - ✅ Good: `Use author-skill when writing/reviewing skill files (SKILL.md).`
    - ❌ Bad: `Use this skill when you want to create a commit. This comprehensive skill helps developers by providing detailed commit messages with conventional commit format and includes analysis of changes...` (verbose, context rot)
* Replace [CONTENT] with translated content from user request into Caveman English:
  - Preferably format as structured sequence lists or bullet points.
  - Only include very critical instructions, rules, links in [CONTENT] or common info always relevant.
  - Extract specialized detail to linked reference md files.
  - Writing templates, scripts, specialized details, as external reference files as follow:
    - Write references in subdirectories of skill directory: `.agents/skills/[NAME]/[reference]`
    - ALWAYS link ALL references in [CONTENT] of `SKILL.md`
    - All links are relative to `SKILL.md` file.
    - Format links as md links in text, for example: `[Email Template](templates/email_template.html)` or `[Process Data Script](scripts/process_data.py)`
  - When rules contradict: Add conditions when each contradicting rule applies.

**IMPORTANT**: ALWAYS write skill files in `.agents/skills/[NAME]/SKILL.md`

---

## Skill File Rules

* Use `author-caveman` skill to write SKILL.md files in Caveman English.
* No repetitions
* Only use emojis to highlight important aspects to LLM, like attention, warning, checklists, correct vs wrong
* ALWAYS keep md < 400 lines by:
  - Cleaning up redundant content
  - Removing excessive examples
  - Summarize trivial info in [CONTENT] section
  - Only if skill's  [CONTENT] section is > 100 lines:
    1. Divide content into smaller < 100 line sections
    2. Divided skills user content should not overlap
    3. Move subdivided content to reference files (located in `.agents/skills/[NAME]/`) and link to it.
  - As last resort: Reducing/grouping obvious instructions agent can derive by itself

___

Use this same skill text as an example on how to format other skills.
