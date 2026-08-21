---
name: design-prd
description: Use `design-prd` to get Product Requirements when planning any feature or to understand project business requirements, user roles, and success criteria.
---

## Problem Statement

AutoCode turns rough ideas into concepts, durable designs, and OpenCode work. Users choose autonomous or human-steered execution. Unsafe work gets manual hand-off.

## Feature Requirements

- **Concept flow**: User saves early Markdown concepts in `.agents/concepts/` with `/job-concepts`.
- **Design flow**: `/job-design` investigates selected concept or current context.
- **Execution modes**: User selects `auto` with `/job-execute` or human-steered `assist` with `/job-facilitate`.
- **Durability**: Workspace persists at creation path. No status directories or lifecycle transitions.
- **Session fallback**: Blank `autocode_session_create` prompt loads newest current-title design. No design gives retriable provide-`prompt` error. Nonblank prompt bypasses lookup.
- **Heading contract**: Only `advise`, `assist`, `auto` turns with first eligible text line `# {emoji} {title}` update root title. Generated postfix replaces; other title appends. Failure advisory.
- **Safety hand-off**: Give human manual steps for unsafe work.
- **Read-only DB**: Read one configured table at time. No DB writes or cross-table joins.
- **Sandboxing**: Run supported risky commands in Linux Bubblewrap sandbox when host supports it.
- **Cross-project tasking**: Start isolated OpenCode work in other project only after directory permission check.
- **SSH suite**: Run remote commands and file work through environment-keyed SSH tools.
- **Learned skills**: Save corrections, env facts, permissions, and preferences for later sessions.

## User Roles

- **User**: Create concepts, choose design, steer execution, and confirm results.
- **advise agent**: Gather evidence, answer questions, and guide manual work.
- **design agent**: Make designs from concept or context.
- **auto agent**: Run design work alone.
- **assist agent**: Run work with user steering.

## Constraints & Assumptions

- Plugin runs inside OpenCode. No web server or special UI.
- Concepts and job workspaces live in version-control text files.
- Workspace paths stay stable after design creation.
- External directory rule is `allow`, `ask`, or `deny`.
- SSH targets use `AUTOCODE_SSH_{ssh_key}_*` environment values.
- Learned skills prune per category by configured newest-item limit.

## Success Metrics

- Design workspace path stays stable during execution.
- Criteria measure solution completion.
- Unsafe work gets human hand-off.
- User resumes and audits work from design files and session IDs.
- Learned facts help later sessions.

## UX/UI Considerations

No special UI. Work uses OpenCode agents, slash commands, and text files. Show design path, selected execution mode, next action, and whether manual help is needed.

## User Stories

- As a user, I want concept and design files so work starts from clear requirements.
- As a user, I want auto or assist mode so I choose autonomy level.
- As a user, I want blocked unsafe work stopped so I can help safely.
- As a user, I want criteria so done work stays trusted.
- As a user, I want safe read-only DB lookup so data stays unchanged.
- As a user, I want saved corrections and preferences so later work fits my needs.

---

**IMPORTANT**: Edit this `design-prd` skill whenever product requirements, user roles, or business rules change.
