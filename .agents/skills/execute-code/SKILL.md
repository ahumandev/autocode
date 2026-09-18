---
name: execute-code
description: Use `execute-code` to get "Technical Design" when you must design technical tasks, implement features or refactor code.
---

## Architectural Overview
TypeScript OpenCode plugin. Plugin registers agents, commands, skills, config, and runtime tools. OpenCode sessions own workflow and state. Job workspaces hold temp tool artifacts only.

## Technology Choices
- **TypeScript**: Plugin source and Bun build target.
- **OpenCode**: Hosts plugin agents, commands, config, tools, and sessions.
- **JSONC**: Layered user and project config.

## Key Data Models
- **Concept** (`.agents/concepts/`): Optional saved Markdown input for design agents.
- **Tier set** (`autocode.jsonc`): Named model and variant overrides by agent tier.
- **Local memory** (`.opencode/autocode/memories/`): Runtime Markdown `.md` memory files created only through `learn`; fresh transition starts empty.

## Key API Endpoints
- `/job-concepts` (`src/commands/job-concepts.ts`): Save concept Markdown.
- `/new-design` (`src/commands/index.ts`): Start OpenCode design session.
- `/resume` (`src/commands/index.ts`): Resume interrupted OpenCode session.

## Error Handling
- **Tool errors** (`src/utils/tools.ts`): Shared tool error rules.
- **Agent errors** (`src/agents/prompts/error.ts`): Managed agent error rules.

## Security Design
No app auth layer. External-directory rules use last matching rule. Database tools read only. REST and SSH credentials use environment variables. Sandbox tools deny on unsupported hosts.

## External Integrations
- **GitHub** (`src/skills/github.jsonc`): Sync tracked skill snapshots — GitHub.
- **REST services** (`src/tools/`): Request and cached response tools — HTTP.
- **Databases** (`src/tools/`): Discover and read configured tables — DB connection.
- **SSH targets** (`src/tools/`): Remote command and file tools — SSH.

## Directory Structure
- **Agents** (`src/agents/`): Managed agents and prompts.
- **Commands** (`src/commands/`): Slash-command registration.
- **Tools** (`src/tools/`): Runtime tool implementations.
- **Skills** (`src/skills/`): Bundled guidance and GitHub snapshots.
- **Temp workspaces** (`.agents/jobs/`): Tool artifacts only; no workflow state.
- **Memory store** (`.opencode/autocode/memories/`): Active local-memory Markdown `.md` files only.

## Special Files
- `scripts/copy-skill-sources.ts`: Copy bundled skills into `dist/skills`.
- `.opencode/plugin/autocode.ts`: Local shim re-exports built plugin.

## Known Risks & Anti-Patterns
- **Tier config**: Missing override uses agent or OpenCode default.
- **GitHub snapshots**: Sync accepts redistribution risk; grants no rights.
- **Sandbox support**: Unsupported hosts deny all sandbox tools.
- **Job workspace**: Tools create or reuse per-session temp workspace on demand.

---

**IMPORTANT**: Edit this `execute-code` skill whenever architecture, APIs, data models, security, or integrations change.
