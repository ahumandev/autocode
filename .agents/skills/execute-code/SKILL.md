---
name: execute-code
description: Use `execute-code` to get "Technical Design" when you must design technical tasks, implement features or refactor code.
---

## Architectural Overview
OpenCode plugin injects agents, commands, tools, generated skills, external skills, and config. Runtime merges repo and user config, applies policy, sets subagent depth minimum 4, and manages jobs under `.agents/jobs/`.

## Technology Choices
- **TypeScript**: Type SDK hooks, tools, config, and policies.
- **@opencode-ai SDK/plugin**: Native agent, command, tool, and session hooks.
- **JSONC config**: User/project overrides keep comments.
- **Markdown skills**: Managed skills generated; external GitHub skills cloned and symlinked.

## Key Data Models
- **AgentConfig** (`src/agents/index.ts`): Agent prompt, permissions, tier, sandbox policy.
- **Autocode config** (`src/config.ts`): Tiers, external paths, sandbox, skill URLs, learned limit.
- **Job lifecycle state** (`src/utils/jobs.ts`): concepts → drafts → assist/executing/facilitate/review → shelved.
- **ManagedSkillDefinition** (`src/skills/index.ts`): Bundled skill frontmatter and body.
- **ExternalSkill** (`src/utils/external.ts`): GitHub skill name, owner, project, category.

## Key API Endpoints
- `/job-concepts` (`src/commands/index.ts`): Save concept markdown.
- `/job-design` (`src/commands/index.ts`): Read concept, create plan.
- `/job-draft` (`src/commands/index.ts`): Save draft plan.
- `/job-execute-assist` (`src/commands/index.ts`): Start assisted execution.
- `/job-execute-auto` (`src/commands/index.ts`): Start autonomous execution.
- `/job-review-commit` (`src/commands/index.ts`): Commit and shelve accepted job.
- `/learn` (`src/commands/learn.ts`): Store categorized learned skill.

## Error Handling
- **Tool error JSON** (`src/utils/tools.ts`): Normalize `failedAction`, `error`, `instruction`.
- **Retry/abort escalation** (`src/utils/tools.ts`): Retry same failure up to 5, then abort.
- **Config parse errors** (`src/config.ts`): Invalid JSONC throws file-path error.
- **Skill bootstrap** (`src/plugin.ts`): Log external-skill failures; do not break startup.
- **Learned cleanup** (`src/skills/index.ts`): Log per-category cleanup errors; retain uninspectable dirs.

## Security Design
OpenCode owns auth/session context. Agents default-deny then allow named tools, tasks, and skills. External-directory and sandbox policies remove unsafe access. External skills only parse supported GitHub URLs, then receive category-agent skill permission. No repo secrets; use `${ENV_VAR}`.

## External Integrations
- **OpenCode client/session APIs** (`src/tools`, `src/utils/jobs.ts`): Session and job orchestration — SDK
- **Filesystem** (`src/config.ts`, `src/utils/jobs.ts`, `src/skills/index.ts`): Config, jobs, generated, learned skills — Node fs
- **Sandbox runtime** (`src/tools/autocode_sandbox_*`, `src/agents/index.ts`): Local sandbox lifecycle — local process
- **GitHub** (`src/utils/external.ts`): Clone configured skill repos, symlink skills — Git

## Directory Structure
- **Agents** (`src/agents/`): Prompts, policies, agent definitions.
- **Commands** (`src/commands/`): Programmatic slash-command templates.
- **Tools** (`src/tools/`): OpenCode tool implementations and tests.
- **Utils** (`src/utils/`): Shared config, jobs, sandbox, error, external-skill helpers.
- **Skills sources** (`src/skills/`): Bundled managed-skill Markdown.
- **Job storage** (`.agents/jobs/`): Job lifecycle artifacts.
- **Learned skills** (`.agents/skills/learned-*`): Per-item corrections, environment, permissions, preferences.

## Special Files
- `src/skills/index.ts`: Generates managed skills; prunes learned skills by newest max.
- `src/config.ts`: Loads `.opencode/autocode.jsonc` and validates skills/learned settings.
- `src/plugin.ts`: Merges plugin config; bootstraps external skills; enforces subagent depth 4.
- `src/utils/external.ts`: Parses, clones, symlinks configured GitHub skills.

## Known Risks & Anti-Patterns
- **Overlapping policy sources**: User config and plugin defaults both shape permissions.
- **External skill startup I/O**: Git clone and symlink work delays startup.
- **Dynamic job paths**: Layout assumptions can break cross-worktree flow.
- **Generated skill overwrite**: Managed generated-skill root clears each load.
- **Platform-gated sandbox**: Unsupported hosts disable sandbox paths.

---

**IMPORTANT**: Update `.agents/skills/execute-code/SKILL.md` whenever architecture, APIs, data models, security, or integrations change.
