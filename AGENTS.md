OpenCode plugin that orchestrates fire-and-forget AI task execution via file-based workflows.

## Source Directory Map

- `src/agents/` — Agent implementations (`plan`, `build`)
- `src/commands/` — Command handlers (`autocode-analyze`, `autocode-review`, etc.)
- `src/tools/` — OpenCode tool implementations (`session.ts`, `analyze.ts`, `build.ts`)
- `src/core/` — Core config, types, and constants (`config.ts`, `types.ts`)
- `src/utils/` — Common utilities that can be reused throughout the project

## *REQUIRED* Reading

- [Installation and Usage Documentation](INSTALL.md) — Setup, build, test, and global install
- [Security Documentation](SECURITY.md) — Authorization, permissions, input validation

## Key Architectural Patterns

### Tool Factory Pattern (Closure-based DI)
Tools are created via factory functions that capture the OpenCode client at plugin init:
- `createAnalyzeTools()`, `createBuildTools()`
- Enables per-tool client isolation and testability

### Configuration
- Async loading: `loadConfig()` in `src/core/config.ts`
- Sync creation: `createConfig()` for defaults
- TypeScript camelCase ↔ JSON snake_case mapping
- Zod enums for `Stage` and `TaskStatus`

### Error Handling
- **Pattern**: `try/catch` → return `❌ message` strings to agents
- **No custom exceptions** — distributed error handling
- **Gotchas**:
  - `src/plugin.ts`: `.catch()` on `initAutocode` → `console.warn` (silent failure)
  - `src/core/config.ts`: bare `catch {}` silently falls back to defaults
  - `src/tools/session.ts`: NO try/catch — uses `throwOnError: true` (propagates errors)
  - `spawn_session` tool has no error guard — failures bubble up

### Filesystem & Permissions
- All file ops scoped to `.autocode/` via `path.join()`
- Agent permissions: `plan` (read-only), `build` (filesystem only)
- Input sanitization: plan name validation in `src/tools/build.ts`
  - 7-word limit, abbreviation, deduplication
- Use `input.worktree` (not `process.cwd()`)

## Tools Exposed

- `autocode_analyze_list` — List ideas in `.autocode/analyze/`
- `autocode_analyze_read` — Read idea file content
- `autocode_build_plan_name` — Generate sanitized plan name

## Agents

- **`plan`** — Interview/research/planning agent; reads ideas, generates plans
- **`build`** — Converts approved plans to task structure; orchestrates execution

## Commands

- `autocode-analyze` — Scan `.autocode/analyze/` and start planning
