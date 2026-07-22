---
name: design-prd
description: Use `design-prd` to get Product Requirements when planning any feature or to understand project business requirements, user roles, and success criteria.
---

## Problem Statement
AutoCode turns rough ideas into traceable OpenCode jobs. Files keep plan, work, review, and close trail. Users choose auto work or human-steered work. Unsafe work stops for human help.

## Feature Requirements
- **Job lifecycle**: Keep concept, draft, assist, executing, facilitate, review, and shelved jobs under `.agents/jobs/`.
- **Planning flow**: User creates concept. Design makes plan. User saves draft before work.
- **Execution modes**: Run drafted job in `auto` mode or human-steered `assist` mode.
- **Review flow**: Accept reviewed work only after all criteria clear. Then shelve job.
- **Safety gates**: Move blocked unsafe work to `facilitate`. Give human manual steps.
- **Read-only DB**: Read one configured table at time. No DB writes or cross-table joins.
- **Sandboxing**: Run supported risky commands in Linux Bubblewrap sandbox when host supports it.
- **Cross-project tasking**: Start isolated OpenCode work in other project only after directory permission check.
- **SSH suite**: Run remote commands and file work through environment-keyed SSH tools.
- **Learned skills**: Save corrections, env facts, permissions, and preferences for later sessions.

## User Roles
- **User**: Create, approve, steer, review, accept, or shelve jobs.
- **research agent**: Gather evidence. Make Research Report.
- **design agent**: Make plans and drafts from concept or context.
- **auto agent**: Run drafted job alone.
- **assist agent**: Run work with user steering.
- **edit agent**: Make fast in-session targeted edits.

## Constraints & Assumptions
- Plugin runs inside OpenCode. No web server or special UI.
- Job state lives in version-control text files.
- External directory rule is `allow`, `ask`, or `deny`.
- SSH targets use `AUTOCODE_SSH_{ssh_key}_*` environment values.
- Learned skills prune per category by configured newest-item limit.

## Success Metrics
- Jobs move lifecycle dirs. No silent state drift.
- Criteria block acceptance until clear.
- Unsafe work gets human hand-off.
- User resumes and audits work from job files and session IDs.
- Learned facts help later sessions.

## UX/UI Considerations
No special UI. Work uses OpenCode agents, slash commands, and text files. Show job path, state, next action, and whether user approval or manual help is needed.

## User Stories
- As a user, I want concept and draft files so work starts from clear requirements.
- As a user, I want auto or assist mode so I choose autonomy level.
- As a user, I want blocked unsafe work stopped so I can help safely.
- As a user, I want criteria gate before accept so done work stays trusted.
- As a user, I want safe read-only DB lookup so data stays unchanged.
- As a user, I want saved corrections and preferences so later work fits my needs.

---

**IMPORTANT**: Edit this `design-prd` skill whenever product requirements, user roles, or business rules change.
