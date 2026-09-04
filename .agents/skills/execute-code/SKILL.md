---
name: execute-code
description: Use `execute-code` to get "Technical Design" when you must design technical tasks, implement features or refactor code.
---

## Architectural Overview
TypeScript OpenCode plugin. Plugin registers agents, commands, skills, config, and runtime tools. Text files keep concept and design workspace state.

## Technology Choices
- **TypeScript**: Plugin source and Bun build target.
- **OpenCode**: Hosts plugin agents, commands, config, and tools.
- **JSONC**: Layered user and project config.

## Key Data Models
- **Concept** (`.agents/concepts/`): Saved concept input for design work.
- **Design workspace** (`.agents/jobs/`): Timestamped `design.md` work plan and script artifacts.
- **Tier set** (`autocode.jsonc`): Named model and variant overrides by agent tier.

## Key API Endpoints
- `/job-concepts` (`src/commands/`): Save concepts.
- `/job-design` (`src/commands/`): Make design workspace.
- `/job-facilitate` (`src/commands/`): Select `assist` execution.
- `/job-execute` (`src/commands/`): Select `auto` execution.

## Error Handling
- **Tool errors** (`src/utils/tools.ts`): Shared tool error rules.
- **Agent errors** (`src/agents/prompts/error.ts`): Managed agent error rules.

## Security Design
External-directory rules use last matching rule. Database tools read only. REST and SSH credentials come from environment variables. Sandbox tools deny when host lacks supported isolation.

## External Integrations
- **GitHub** (`src/skills/github.jsonc`): Sync tracked skill snapshots — GitHub.
- **REST services** (`src/tools/`): Request and cached response tools — HTTP.
- **Databases** (`src/tools/`): Discover and read one configured table — DB connection.
- **SSH targets** (`src/tools/`): Remote command and file tools — SSH.

## Directory Structure
- **Agents** (`src/agents/`): Managed agents and prompts.
- **Commands** (`src/commands/`): Slash-command registration.
- **Tools** (`src/tools/`): Runtime tool implementations.
- **Skills** (`src/skills/`): Bundled guidance and GitHub snapshots.

## Special Files
- `scripts/copy-skill-sources.ts`: Copy bundled skills into `dist/skills`.
- `.opencode/plugin/autocode.ts`: Local shim re-exports built plugin.

## Known Risks & Anti-Patterns
- **Tier config**: Missing override uses agent or OpenCode default.
- **GitHub snapshots**: Sync accepts redistribution risk; grants no rights.
- **Sandbox support**: Unsupported hosts deny all sandbox tools.

---

**IMPORTANT**: Edit this `execute-code` skill whenever architecture, APIs, data models, security, or integrations change.
