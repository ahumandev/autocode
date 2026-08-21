---
name: execute-code
description: Use `execute-code` to get "Technical Design" when you must design technical tasks, implement features or refactor code.
---

## Architectural Overview

OpenCode plugin injects agents, commands, tools, generated skills, bundled GitHub skill snapshots, and config. Runtime merges repo and user config, applies policy, sets subagent depth minimum 4, and keeps durable design workspaces under `.agents/jobs/`.

## Technology Choices

- **TypeScript**: Type SDK hooks, tools, config, and policies.
- **@opencode-ai SDK/plugin**: Native agent, command, tool, and session hooks.
- **JSONC config**: User/project overrides keep comments.
- **Markdown skills**: Managed skills generated; reviewed GitHub snapshots bundled at build time.

## Key Data Models

- **AgentConfig** (`src/agents/index.ts`): Agent prompt, permissions, tier, sandbox policy.
- **Autocode config** (`src/config.ts`): Tiers, external paths, sandbox, skill URLs, learned limit.
- **Concept** (`src/tools/autocode_concept_*.ts`): Markdown item under `.agents/concepts/`.
- **Job workspace** (`src/utils/jobs.ts`): `.agents/jobs/YYYY-MM-DD_hh-mm-ss_{title_dir}/design.md`; timestamp UTC, title-derived directory, persistent path.
- **Session-owned sandbox** (`src/tools/autocode_sandbox_*`, `src/utils/sandbox.ts`): Canonical path exactly `.agents/jobs/YYYY-MM-DD_hh-mm-ss_{title_dir}/sandboxes/{sandbox_name}`; resolve current job from linked session first, otherwise deterministic newest timestamped workspace matching current session-title slug. No owner returns an error; each resolved job scopes access, list, create, copy, and delete, so same `{sandbox_name}` may exist independently in multiple jobs. Never access, fall back to, migrate, scan, delete, or write legacy `.agents/sandboxes`; legacy data remains untouched and inaccessible.
- **ManagedSkillDefinition** (`src/skills/index.ts`): Bundled skill frontmatter and body.
- **ExternalSkill** (`src/utils/external.ts`): GitHub skill name, owner, project, category.

## Key API Endpoints

- `/job-concepts` (`src/commands/index.ts`): Save concept Markdown.
- `/job-design` (`src/commands/index.ts`): Design solution from concept or context.
- `/job-facilitate` (`src/commands/index.ts`): Select assisted execution.
- `/job-execute` (`src/commands/index.ts`): Select autonomous execution.
- `autocode_session_create` (`src/tools/autocode_session_create.ts`): Blank prompt loads newest current-title design; explicit nonblank prompt bypasses lookup.
- `/learn` (`src/commands/learn.ts`): Store categorized learned skill.

## Error Handling

- **Tool error JSON** (`src/utils/tools.ts`): Normalize `failedAction`, `error`, `instruction`.
- **Retry/abort escalation** (`src/utils/tools.ts`): Retry same failure up to 5, then abort.
- **Config parse errors** (`src/config.ts`): Invalid JSONC throws file-path error.
- **Bundled GitHub skills** (`src/plugin.ts`): Startup uses snapshots only; no clone, symlink, or network bootstrap.
- **Learned cleanup** (`src/skills/index.ts`): Log per-category cleanup errors; retain uninspectable dirs.
- **Root title hook** (`src/hooks/root_session_title.ts`): Accept `advise`, `assist`, `auto` heading contract; title failures advisory.

## Security Design

OpenCode owns auth/session context. Agents default-deny then allow named tools, tasks, and skills. External-directory and sandbox policies remove unsafe access. Sandbox ownership returns an error before filesystem mutation or process spawn when no current job resolves. External skills only parse supported GitHub URLs, then receive category-agent skill permission. No repo secrets; use `${ENV_VAR}`.

## External Integrations

- **OpenCode client/session APIs** (`src/tools`, `src/utils/jobs.ts`): Session and workspace orchestration — SDK
- **Filesystem** (`src/config.ts`, `src/utils/jobs.ts`, `src/skills/index.ts`): Config, concepts, workspaces, generated, learned skills — Node fs
- **Sandbox runtime** (`src/tools/autocode_sandbox_*`, `src/agents/index.ts`): Session-owned local sandbox lifecycle — local process
- **GitHub** (`scripts/sync-skills.ts`): Sync reviewed skill snapshots before build — Git

## Directory Structure

- **Agents** (`src/agents/`): Prompts, policies, agent definitions.
- **Commands** (`src/commands/`): Programmatic slash-command templates.
- **Tools** (`src/tools/`): OpenCode tool implementations and tests.
- **Utils** (`src/utils/`): Shared config, jobs, sandbox, error, external-skill helpers.
- **Skills sources** (`src/skills/`): Bundled managed-skill Markdown.
- **Concept storage** (`.agents/concepts/`): Early concept Markdown.
- **Job storage** (`.agents/jobs/`): Durable timestamped design workspaces; no status transitions.
- **Sandbox storage** (`.agents/jobs/*/sandboxes/`): Per-job sandbox trees at canonical paths; legacy `.agents/sandboxes` remains untouched and inaccessible.
- **Learned skills** (`.agents/skills/`): Per-item corrections, environment, permissions, preferences.

## Special Files

- `src/skills/index.ts`: Generates managed skills; prunes learned skills by newest max.
- `src/config.ts`: Loads `.opencode/autocode.jsonc` and validates skills/learned settings.
- `src/plugin.ts`: Merges plugin config; loads bundled skills; enforces subagent depth 4.
- `src/utils/external.ts`: Parses supported GitHub skill definitions for offline snapshots.

## Known Risks & Anti-Patterns

- **Overlapping policy sources**: User config and plugin defaults both shape permissions.
- **GitHub snapshot review**: Sync output needs manual Git review before commit.
- **Dynamic job paths**: Layout assumptions can break cross-worktree flow.
- **Frozen generated skills**: `autocode.skills.freeze` leaves stale generated skills in place.
- **Platform-gated sandbox**: Unsupported hosts disable sandbox paths.
- **Sandbox cleanup and kill scan**: Remove only empty workspace `sandboxes` directories; exclude valid canonical sandbox trees from kill scans while scanning other workspace files.

---

**IMPORTANT**: Update `.agents/skills/execute-code/SKILL.md` whenever architecture, APIs, data models, security, or integrations change.
