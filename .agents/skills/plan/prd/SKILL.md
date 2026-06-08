---
name: plan-prd
description: Use this skill before planning any feature to understand the project's business requirements, user roles, and success criteria.
---

# Product Requirements

## Problem Statement
OpenCode users need consistent planned, execution, review, and documentation workflows without manually wiring agents, commands, tools, skills, and job lifecycle management for each project.

## Feature Requirements
- **Configuration injection**: Inject bundled agents, commands, tools, and generated skills at `src/plugin.ts`.
- **Primary agents**: Provide `research`, `design`, `auto`, and `assist` workflows for evidence gathering, solution planning, autonomous execution, and guided execution.
- **Specialist subagents**: Delegate authoring, testing, design, review, research, and troubleshooting work.
- **Permission scoping**: Keep agent permissions narrow; `auto` stays deny-by-default with criteria/job tools, `assist` is human-guided with read/question and limited task access, and database tools remain read-only.
- **Bundled commands**: Register `/job-concepts`, `/job-design`, `/job-draft`, `/job-execute-assist`, `/job-execute-auto`, `/job-review`, `/job-terminate`, and documentation commands.
- **Concept creation**: `/job-concepts` writes concept Markdown for later solution planning.
- **Solution planning**: `/job-design` uses optional concepts or Research Reports as planning context, then `/job-draft` saves the executable plan.
- **Plan revision**: Revise executable plans or active planned jobs in-place with the `design` agent; report the actual plan path changed.
- **Job lifecycle management**: Derive canonical lifecycle state from `.agents/jobs/concepts/{label}.md` plus active `.agents/jobs/{drafts,assist,executing,facilitate,review,terminated}/{job_name}/` locations.
- **Job listing**: List jobs by scanning active lifecycle directories with optional status filtering via `autocode_job_list`.
- **Job status tracking**: Move one planned job directory between logical statuses with `autocode_job_status`; user-facing feedback is required before the tool call and is appended as a guarded entry in `solution.md`.
- **Execution sessions**: Start/resume planned jobs through SDK sessions via `autocode_job_execute`, or start clean ad-hoc sessions without lifecycle state.
- **Review workflow**: Handle user revisions through direct prompt text and canonical review acceptance.
- **Job completion**: `/job-review` may terminate any eligible job after criteria and commit checks; `/job-terminate` closes work intentionally without acceptance.
- **Criteria tracking**: Track measurable active `C*` criteria in `criteria.yml` as a flat top-level id-to-metric checklist. Blank or omitted proof keeps an item active; factual nonblank proof appends an `Accepted Criteria {criteria}` entry to `solution.md` and removes the item from `criteria.yml`.
- **Plan persistence**: Store executable job plans in `.agents/jobs/drafts/{job_name}/plan.md` with `Problem`, `Requirements`, `Constraints`, `Risks`, and `Proposed Solution` sections.
- **Plan handoff**: Use `autocode_plan_read` as the canonical reader for `plan.md` across draft and active lifecycle locations.

## User Roles
- **OpenCode host**: Loads bundled plugin configuration; manages `.opencode/autocode.jsonc` model tier settings.
- **OpenCode user**: Uses `research`, `design`, `auto`, and `assist` primary workflows; interacts via agents and commands.
- **Planner/researcher**: Creates or revises persisted executable plans; returns report-only research without job creation.
- **Operator/executor**: Runs planned jobs through `auto`/`assist` or immediate ad-hoc tasks through `assist`; responds to review input during execution.
- **Documentation maintainer**: Uses document specialists (`document_prd`, `document_agents`, `document_design`, `document_conventions`, `document_install`, `document_ux`) to keep project memory current.
- **Database reviewer**: Uses read-only database discovery and single-table reads; cannot perform writes or schema changes.

## Constraints & Assumptions
- Autocode is an OpenCode plugin/library, not a standalone web app.
- Project uses Bun: `bun run build`, `bun run watch`, `bun test`, `bun run typecheck`.
- Executable job plans use `plan.md` as the canonical artifact; current workflows do not require `goal.md`.
- Planned-job lifecycle state is derived from canonical directories.
- Canonical lifecycle statuses are exactly: `drafts`, `assist`, `executing`, `facilitate`, `review`, `terminated`.
- Canonical lifecycle locations are exactly `.agents/jobs/concepts/{label}.md`, `.agents/jobs/drafts/{job_name}/`, `.agents/jobs/assist/{job_name}/`, `.agents/jobs/executing/{job_name}/`, `.agents/jobs/facilitate/{job_name}/`, `.agents/jobs/review/{job_name}/`, and `.agents/jobs/terminated/{job_name}/`.
- Criteria path is `.agents/jobs/{status}/{job_name}/criteria.yml`; completion audit path is `.agents/jobs/{status}/{job_name}/solution.md`; planned auto session path is `.agents/jobs/executing/{job_name}/session.yml`.
- Solution audit entries use timestamp format `YY-MM-DD hh:mm:ss` and titles exactly `Update Status To {status}` or `Accepted Criteria {criteria}`.
- Job listing scans active lifecycle directories and filters by valid lifecycle statuses.
- `autocode_plan_read` returns full plan content, raw sections, generated summary maps, and file path.
- Plan tools generate requirement_summaries (REQ*), constraint_summaries (CON*), and risk_summaries (R*) from subsection order/titles.
- Agents must not manually author IDs in plan Markdown.
- Risks remain plan context only; risks are not criteria fields and do not use criteria `risk_ids`.
- Active criteria contain only top-level `C*`: `metric` mappings; they do not store `action` or `proof` metadata.
- Criteria completion is proof-based: blank or omitted proof keeps the criterion active; factual nonblank proof appends a guarded `Accepted Criteria {criteria}` audit entry with timestamp `YY-MM-DD hh:mm:ss` to append-only `solution.md`, then removes the criterion from `criteria.yml`.
- Use criteria listing to find unmet items before requesting review.
- No removal `reason` field is used for criteria.
- Action/proof evidence should be factual and should not include Markdown headers.
- `/job-review` may terminate any eligible job after criteria and commit checks; `/job-terminate` closes work intentionally without acceptance.
- Planned `auto` and `assist` modes mutate lifecycle only when `job_name` is provided; ad-hoc modes do not create lifecycle directories, criteria, sessions, or inferred jobs.
- Model tier configuration supports `autocode.tier` to select provider, with `cheap`/`fast`/`balanced`/`smart` variants per provider.

## Success Metrics
- Executable plans created report `.agents/jobs/drafts/{job_name}/plan.md` with all required sections.
- Auto execution completes all criteria with factual proof before review and leaves guarded completion audit evidence in `solution.md`.
- `/job-review` successfully moves eligible jobs to `.agents/jobs/terminated` and reports final `job_path`.
- Users can distinguish persisted executable plans from report-only research outputs.
- Documentation (AGENTS.md, PRD, design docs) reflects runtime behavior and lifecycle/criteria fields.
- Plan handoff via `autocode_plan_read` works across draft and active lifecycle locations.

## UX/UI Considerations
No standalone UI; users interact through:
- OpenCode agent interfaces (`research`, `design`, `auto`, `assist` primary agents)
- Registered convenience commands (`/job-concepts`, `/job-design`, `/job-draft`, `/job-execute-assist`, `/job-execute-auto`, `/job-review`, `/job-terminate`)
- Tool results, normal prompts, and interactive decisions
- Generated persisted artifacts (`plan.md`, `criteria.yml`, `solution.md`, `session.yml`)
- Lifecycle directory structure (`.agents/jobs/concepts`, `.agents/jobs/drafts`, `.agents/jobs/assist`, `.agents/jobs/executing`, `.agents/jobs/facilitate`, `.agents/jobs/review`, `.agents/jobs/terminated`)

## User Stories
- As an OpenCode user, I want to ask read-only questions so that I get research without changing files.
- As an OpenCode user, I want to create a concept and then design it so that work can become an executable plan.
- As an OpenCode user, I want `/job-design` to use optional concepts or Research Reports before `/job-draft` saves the executable plan so that planning is explicit.
- As a planner, I want to revise an existing draft job or active planned job in-place with the `design` agent so that my changes preserve unchanged sections.
- As an operator, I want to execute a planned job via prompt or `/job-execute-auto <job_name>` so that `auto` runs it autonomously.
- As a collaborator, I want to execute a planned job via `/job-execute-assist <job_name>` so that `assist` can guide interactive execution from planned job context.
- As an executor, I want active criteria tracked in `criteria.yml` and status/criteria events audited in `solution.md` so that execution progress is traceable and reviewable.
- As a planner, I want risks preserved as plan context so that operators understand concerns without tracking risk IDs.
- As an operator, I want to respond to obstacle-driven execution through direct prompt text so that I can clarify or approve next steps.
- As a reviewer, I want to request post-review changes through direct prompt text so that jobs return to drafts for revisions.
- As a reviewer, I want accepted or intentionally closed work moved to `.agents/jobs/terminated/{job_name}/` so that finished jobs are preserved and removed from active lifecycle.
- As a documentation maintainer, I want to use `document_prd`, `document_design`, and other specialists so that workflow docs stay aligned with runtime behavior.

---

**IMPORTANT**: Update `.agents/skills/plan/prd/SKILL.md` whenever product requirements, user roles, or business rules change.
