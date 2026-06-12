---
name: design-prd
description: Use `design-prd` to get Product Requirements when planning any feature or to understand project business requirements, user roles, and success criteria.
---

# Product Requirements

## Problem Statement
AutoCode turns rough ideas into traceable jobs in OpenCode. It keeps concept, plan, execution, review, and shelving in files so work stays auditable, resumable, and safe.

## Feature Requirements
- **Job lifecycle**: Support concept, draft, assist, executing, facilitate, review, shelved job states under `.agents/jobs/`.
- **Planning flow**: Let users create concepts, design plans, and save drafts before execution.
- **Execution modes**: Support `auto` and `assist` execution from drafted jobs.
- **Review flow**: Accept reviewed work only after criteria are cleared, then shelve the job.
- **Shelving flow**: Close jobs without acceptance through shelving.
- **Safety gates**: Move blocked work to `facilitate` instead of continuing unsafely.
- **Read-only DB**: Inspect one configured table at a time with no write access.
- **Sandboxing**: Run supported risky commands in Linux bubblewrap sandboxes when available.
- **Cross-project tasking**: Delegate work to isolated OpenCode sessions in other directories after permission checks.

## User Roles
- **User**: Creates concepts, reviews plans, chooses execution mode, accepts or shelves jobs.
- **research agent**: Gathers evidence and produces research reports.
- **design agent**: Creates solution plans and drafts from concepts or planning context.
- **auto agent**: Executes drafted jobs autonomously.
- **assist agent**: Executes jobs with human steering.

## Constraints & Assumptions
- Repo is OpenCode plugin/library, not standalone app.
- Jobs live in version-controlled text files.
- Valid statuses are `concepts`, `drafts`, `assist`, `executing`, `facilitate`, `review`, `shelved`.
- `/job-execute` only selects from active jobs in `drafts`, `assist`, or `executing`.
- `/job-review` must stop if any acceptance criteria remain unmet.
- `review` re-run through `autocode_job_status` becomes `shelved`.
- `autocode_job_status` needs current assistant text before status update.
- `autocode_job_status` archives sandboxes on shelving.

## Success Metrics
- Jobs move cleanly through planned lifecycle dirs with no silent state drift.
- Acceptance blocked until criteria are met.
- Review and shelving always leave an auditable file trail.
- Users can resume or inspect work from job files and session IDs.

## UX/UI Considerations
No special UI required. Work happens in OpenCode slash commands, agents, and text files. Commands should show clear next actions, selected job paths, and whether a session was created or a draft is required.

## User Stories
- As a user, I want to save a concept so design can create a plan from it.
- As a user, I want to draft a plan so execution starts from explicit requirements.
- As a user, I want to run assist mode so I can steer implementation.
- As a user, I want to run auto mode so routine work can proceed without constant input.
- As a user, I want reviewed work accepted only when criteria are met so finished jobs stay trustworthy.
- As a user, I want to shelve a job so unfinished or rejected work closes cleanly.

---

**IMPORTANT**: Update `.agents/skills/design-prd/SKILL.md` whenever product requirements, user roles, or business rules change.
