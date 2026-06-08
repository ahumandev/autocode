---
name: plan-conventions
description: Use this skill to decide on a name of variable, class, file, system object, label or command; Use this skill also to understand acronyms and project definitions to avoid ambiguous wording.
---

# Project Conventions

## Internal Acronyms
- **C***: Execution criteria IDs stored as top-level keys in `criteria.yml`.

## Definitions
- **Primary agent**: User-facing entry point agent such as `research`, `design`, `auto`, or `assist`.
- **Subagent**: Hidden specialist agent with prefixes like `auto_*`, `query_*`, `execute_*`, `document_*`.
- **Lifecycle statuses**: Canonical status values are `drafts`, `assist`, `executing`, `facilitate`, `review`, and `terminated`.
- **Canonical job directories**: `.agents/jobs/concepts/`, `.agents/jobs/drafts/`, `.agents/jobs/assist/`, `.agents/jobs/executing/`, `.agents/jobs/facilitate/`, `.agents/jobs/review/`, and `.agents/jobs/terminated/`.
- **Terminated job directory**: `.agents/jobs/terminated/` stores accepted or completed jobs after review.
- **Concept label**: The preserved slug for an optional concept before solution-plan drafting.
- **Draft job**: Job with a persisted `plan.md` under `.agents/jobs/drafts/{job_name}/`.
- **Executing job**: Job moved to `.agents/jobs/executing/{job_name}/` for autonomous execution.
- **Plan handoff reader**: `autocode_plan_read` loads draft or active plan context and returns the canonical sections plus summaries.
- **Plan save tool**: `autocode_plan_save` is the canonical save API for creating or updating plans. It persists `plan.md` for the draft job.
- **Plan sections**: H1 sections `Problem`, `Requirements`, `Constraints`, `Risks`, `Proposed Solution`; compatibility aliases `problem`/`solution` and older readable headings like `Problems` or `Solution` are still supported.
- **Requirements / Constraints / Risks subsections**: Use `### <title under 10 words>` inside raw section content.
- **Criteria track file**: `.agents/jobs/{status}/{job_name}/criteria.yml` stores a flat active checklist of top-level `C*`: `metric` mappings only.
- **Lifecycle audit log**: `.agents/jobs/{status}/{job_name}/solution.md` is append-only and stores guarded audit entries for status changes and accepted criteria.
- **Status audit entry**: `autocode_job_status` appends `# YY-MM-DD hh:mm:ss - Update Status To {status}` to `solution.md`.
- **Criteria audit entry**: `autocode_criteria_accept` appends `# YY-MM-DD hh:mm:ss - Accepted Criteria {criteria}` to `solution.md`.
- **Audit timestamp**: Use exactly `YY-MM-DD hh:mm:ss` in lifecycle audit headers.
- **Criteria proof**: Blank or omitted proof keeps an item active; factual nonblank proof appends to `solution.md` and removes the item from active `criteria.yml`.
- **Review job**: Job under `.agents/jobs/review/{job_name}/`; may be accepted or otherwise terminated into `.agents/jobs/terminated/{job_name}/` with `/job-review`.
- **Facilitate job**: Job under `.agents/jobs/facilitate/{job_name}/`; needs help with an obstacle before execution can continue.
- **Planned flow**: `research -> design`, then `design -> auto` or `design -> assist`.
- **Solution planning**: `/job-design` loads optional concept or Research Report context into the current planning session, then continues solution planning before drafting.
- **Draft creation**: `/job-draft` saves the executable plan to `.agents/jobs/drafts/{job_name}/plan.md`.
- **Assist execution**: `/job-execute-assist` runs the same planned job interactively from the current plan context and aligns outcomes toward review or termination.
- **Termination command**: `/job-terminate` closes work intentionally without acceptance.
- **External directory permission**: Permission key `external_directory` authorizes filesystem access to target directories.
- **External directory rules**: `permission.external_directory` centralizes allow/ask/deny rules for both `external_directory` and `task_external`.
- **Task external**: `task_external` spawns a fresh `opencode run --dir` session in another project directory using the built-in `general` agent.
- **Tier set**: A named model bundle selected by `autocode.tier` and defined under `autocode.tiers`.

## Naming Rules
### Tool Naming Convention
**Purpose:** Identify plugin tools by functional domain.
**Pattern:** `autocode_<category>_<function>` in snake_case; examples: `autocode_plan_read`, `autocode_plan_save`, `autocode_job_execute`, `autocode_job_status`.

### Permission Key Convention
**Purpose:** Keep OpenCode permission names aligned with tool and capability scopes.
**Pattern:** Use underscore-separated keys like `external_directory`, `task_external`, `autocode_plan_read`, and `autocode_job_status`; centralized external directory rules apply to both `external_directory` and `task_external`.

### Agent Naming Convention
**Purpose:** Separate user-facing entry agents from delegated specialists.
**Pattern:** Primary agents are single words (`research`, `design`, `auto`, `assist`); subagents use category prefixes such as `auto_feature`, `execute_code`, `query_git`, `document_design`.

### Prompt Export Naming Convention
**Purpose:** Keep prompt exports aligned with their agent or workflow context.
**Pattern:** Prompt exports use camelCase names like `askPrompt`, `autoPrompt`, `buildFeaturePrompt`, `executeCodePrompt`, `documentConventionsPrompt`.

### Tool Creator Function Pattern
**Purpose:** Consistently export tool factory functions with dependency injection.
**Pattern:** Export `create<CamelCase>Tool(fileSystem?: FileSystem)` for each tool; enables testing and filesystem mocking.

### Skill File Organization
**Purpose:** Organize generated skills by domain category.
**Pattern:** Source files use `src/skills/<skill-name>/SKILL.md`; generated skill files land in `~/.agents/skills/autocode/<skill-name>/SKILL.md`. Only `autocode` is plugin-managed; user custom skills live in sibling directories under `~/.config/opencode/skills`.

### Job File Naming Pattern
**Purpose:** Track lifecycle artifacts within job directories.
**Pattern:** Files under `.agents/jobs/{drafts,assist,executing,facilitate,review,terminated}/<job_name>/`: `plan.md`, `criteria.yml`, and `solution.md` as applicable; concepts live at `.agents/jobs/concepts/<label>.md`, planned auto sessions store `session.yml` under `.agents/jobs/executing/<job_name>/`, and lifecycle status/criteria acceptance audits append to `solution.md`.

### Command Template Placeholders
**Purpose:** Enable dynamic command customization.
**Pattern:** `$ARGUMENTS` inserts user arguments; canonical job commands are `/job-concepts`, `/job-design`, `/job-draft`, `/job-execute-assist`, `/job-execute-auto`, `/job-review`, and `/job-terminate`.

### File System Abstraction Pattern
**Purpose:** Enable testing and provide dependency injection for file operations.
**Pattern:** Each tool defines local `FileSystem` interface with the subset of `fs` functions it needs; tools accept an optional filesystem parameter for testing.

### Model Tier Classification
**Purpose:** Select appropriate model capability for task complexity.
**Pattern:** Four-tier system: `cheap` (managed dispatcher and default `small_model` source), `fast` (lightweight tasks), `balanced` (general work), `smart` (complex reasoning). Used in agent config `tier` field and `.opencode/autocode.jsonc`.

### Configuration Precedence
**Purpose:** Describe how local overrides win without duplicating full config.
**Pattern:** Global `~/.config/opencode/autocode.jsonc` loads first, then worktree `.opencode/autocode.jsonc`, then active-directory `.opencode/autocode.jsonc`; later files override earlier values per tier and external-directory rule.

---

**IMPORTANT**: Update `.agents/skills/plan/conventions/SKILL.md` whenever new naming conventions or domain terms are introduced.
