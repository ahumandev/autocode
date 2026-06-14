---
name: execute-code
description: Use `execute-code` to get "Technical Design" when you must design technical tasks, implement features or refactor code.
---

# Technical Design

## Architectural Overview
OpenCode plugin that injects agents, commands, tools, and generated skills. Runtime merges repo config with user config, enforces sandbox/external-directory policies, and manages lifecycle jobs under `.agents/jobs/`.

## Technology Choices
- **TypeScript**: Strong typing for SDK hooks, tools, and config merging.
- **@opencode-ai SDK/plugin**: Native integration point for agents, commands, and tool APIs.
- **JSONC config**: User/project overrides without losing comments.
- **Markdown skills**: Bundled from `src/skills/*/SKILL.md` into generated skill paths.

## Key Data Models
- **AgentConfig** (`src/agents/index.ts`): Agent prompt, permissions, model tier, and sandbox policy.
- **Autocode config** (`src/config.ts`): Tier map, external directory rules, sandbox sync settings.
- **Job lifecycle state** (`src/utils/jobs.ts`): concepts → drafts → assist/executing/facilitate/review → shelved.
- **ManagedSkillDefinition** (`src/skills/index.ts`): Bundled skill frontmatter + body.

## Key API Endpoints
- `/job-concepts` (`src/commands/index.ts`): Save concept markdown.
- `/job-design` (`src/commands/index.ts`): Read concept, create plan.
- `/job-draft` (`src/commands/index.ts`): Save plan to draft folder.
- `/job-execute-assist` (`src/commands/index.ts`): Start assisted execution session.
- `/job-execute-auto` (`src/commands/index.ts`): Start autonomous execution session.
- `/job-review` (`src/commands/index.ts`): Check criteria, shelve accepted work.
- `/job-shelve` (`src/commands/index.ts`): Close job without acceptance.

## Error Handling
- **Tool error JSON** (`src/utils/tools.ts`): Normalized `failedAction`, `error`, `instruction` payloads.
- **Retry/abort escalation** (`src/utils/tools.ts`): Same failure retries up to 5, then abort.
- **Config parse errors** (`src/config.ts`): Malformed JSONC throws with file path.
- **Session/tool failures** (`src/tools/*`): Abort or retry based on tool-specific instruction text.

## Security Design
Auth is delegated to OpenCode session/client context. Security control is mostly permission policy: agents default-deny, then selectively allow task/tool access, external directories, and sandbox tools. `applyExternalDirectoryPolicy()` and `applySandboxPlatformPolicy()` remove unsafe access when platform support is missing. No secrets are stored in repo config; use `${ENV_VAR}` placeholders.

## External Integrations
- **OpenCode client/session APIs** (`src/tools`, `src/utils/jobs.ts`): Session create/update/prompt and job orchestration — SDK
- **Filesystem** (`src/config.ts`, `src/utils/jobs.ts`, `src/skills/index.ts`): Reads local/project/global config and job files — Node fs
- **Sandbox runtime** (`src/tools/autocode_sandbox_*`, `src/agents/index.ts`): Creates/cleans sandboxes and gates unsupported platforms — local process

## Directory Structure
- **Agents** (`src/agents/`): Primary prompts, rules, and agent definitions.
- **Commands** (`src/commands/`): Programmatic command templates.
- **Tools** (`src/tools/`): OpenCode tool implementations and tests.
- **Utils** (`src/utils/`): Shared config, job, sandbox, and error helpers.
- **Skills sources** (`src/skills/`): Bundled generated-skill Markdown.
- **Job storage** (`.agents/jobs/`): Concepts, drafts, execution, review, and shelving artifacts.

## Special Files
- `src/skills/index.ts`: Bundles managed skills into generated config path.
- `src/config.ts`: Loads global/local `.opencode/autocode.jsonc` overrides.
- `src/plugin.ts`: Final merge hook for agents, commands, tools, and skills.
- `src/agents/prompts/execute_code.ts`: Canonical execution prompt for code-writing sessions.

## Known Risks & Anti-Patterns
- **Overlapping policy sources**: User config and plugin defaults both shape permissions.
- **Dynamic job path resolution**: File layout assumptions can break cross-worktree flows.
- **Generated skill overwrite**: `ensureGeneratedSkills()` clears stale generated skill dirs each load.
- **Platform-gated sandbox tools**: Unsupported hosts disable sandbox execution paths.

---

**IMPORTANT**: Update `.agents/skills/execute-code/SKILL.md` whenever architecture, APIs, data models, security, or integrations change.
