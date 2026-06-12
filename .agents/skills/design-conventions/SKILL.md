---
name: design-conventions
description: Use `design-conventions` to get Project Conventions when deciding on names, job vocabulary, or skill terms to avoid repo-specific ambiguity.
---

# Project Conventions

## Internal Acronyms
- **job_name**: Canonical job folder key; also used as session title target.
- **session_id**: Persisted OpenCode session identifier stored in `session.yml`.
- **session_title**: Human-facing session name, usually synced to `job_name`.
- **SKILL.md**: Source skill file consumed and re-rendered into generated skill bundles.

## Definitions
- **Concept**: Idea note saved under `.agents/jobs/concepts/` before planning.
- **Draft / plan**: Proposed solution saved as `plan.md` under `.agents/jobs/drafts/{name}/`.
- **Planned job**: Job with a stable `job_name` and lifecycle directory.
- **Lifecycle directory**: One of `concepts`, `drafts`, `assist`, `executing`, `facilitate`, `review`, `shelved`.
- **Active lifecycle**: Any lifecycle except `shelved`.
- **Generated skill**: Rendered copy of `src/skills/*/SKILL.md` written to the user skill store.
- **Primary agent**: One of `assist`, `auto`, `research`, `design`.
- **Temp agent**: Internal orchestration agent prefixed with `temp_`.

## Naming Rules
### Job lifecycle names
**Purpose:** Keep job state and filesystem paths aligned.
**Pattern:** Use exact lifecycle names: `concepts`, `drafts`, `assist`, `executing`, `facilitate`, `review`, `shelved`. Do not invent new status words.

### Planned job folder shape
**Purpose:** Make jobs discoverable and movable across states.
**Pattern:** Use `.agents/jobs/{status}/{job_name}/` with `plan.md`, `criteria.yml`, `solution.md`, and `session.yml` as needed.

### Session/job sync
**Purpose:** Preserve one job identity across session and title updates.
**Pattern:** Store `session_id` in `session.yml`; sync session title to `job_name` when lifecycle changes.

### Command vocabulary
**Purpose:** Separate user commands from internal tool names.
**Pattern:** User commands use kebab-case `job-*` and `document-*`; tool names use `autocode_*`; internal agents use `temp_*`, `execute_*`, `query_*`, `document_*`, `auto_*`.

### Generated skill packaging
**Purpose:** Keep bundled skills deterministic.
**Pattern:** Source skills live in `src/skills/{name}/SKILL.md`; generated output is written to `~/.agents/skills/autocode/{name}/SKILL.md` (or XDG config equivalent).
