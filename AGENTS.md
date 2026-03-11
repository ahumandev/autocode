Opencode plugin that orchestrates fire-and-forget AI task execution via file-based workflows.

## Source Directory Map

- `src/agents/` — Agent implementations (`plan`, `build`, `orchestrate`, `recover`)
- `src/agents/prompts/` — Prompt files for agents, including `recover.ts`
- `src/commands/` — Command handlers (`autocode-analyze`, `autocode-review`, etc.)
- `src/tools/` — Claude Code tool implementations (`analyze.ts`, `build.ts`, `orchestrate.ts`, `session.ts`)
- `src/core/` — Core config, types, and constants (`config.ts`, `types.ts`)
- `src/utils/` — Common utilities that can be reused throughout the project

## *REQUIRED* Reading

- [Installation and Usage Documentation](INSTALL.md) — Setup, build, test, and global install
- [Security Documentation](SECURITY.md) — Authorization, permissions, input validation

## Key Architectural Patterns

### Tool Factory Pattern (Closure-based DI)
Tools are created via factory functions that capture the Claude Code client at plugin init:
- `createAnalyzeTools()`, `createBuildTools()`, `createOrchestrateTools()`, `createSessionTools()`
- Enables per-tool client isolation and testability

### Configuration
- Async loading: `loadConfig()` in `src/core/config.ts`
- Sync creation: `createConfig()` for defaults
- TypeScript camelCase ↔ JSON snake_case mapping
- Zod enums for `Stage` and `TaskStatus`

### Error Handling & Response Helpers
- **Unified contract**: All tools return `{ error: "..." }` JSON on failure
- **Response helpers** (`src/utils/validation.ts`):
  - `successResponse(sid, toolName, result?)` — Returns result and resets retry counter
  - `retryResponse(sid, toolName, paramName, constraint, onMaxRetries?)` — Increments retry counter; escalates to abort after 5 retries
  - `abortResponse(toolName, reason)` — Stateless; used for system/IO failures
- **Retry tracking** (`src/utils/retry-tracker.ts`):
- **Parameter validators**: validators for null-or-error-string pattern (non-empty, max words, length, format, alphanumeric)
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

### Task File Structure

**Before execution:**
- `background.md` — Context/reason for the task (written if background param provided)
- `{agent_name}.prompt.md` — Execution instructions for the specific agent
- `verification.prompt.md` — Verification instructions (custom or auto-generated)

**After execution:**
- `{agent_name}.session.{id}.md` — Entire agent interaction session transcript
- `{agent_name}.result.{ts}.md` — Last agent's response
- `verification.session.{id}.md` — Entire verification interaction session transcript
- `verification.result.{ts}.md` — Last verification response

## Agents

- **`plan`** — Interview/research/planning agent; reads ideas, generates plans
- **`build`** — Converts approved plans to task structure; orchestrates execution
- **`recover`** — Automatically invoked by orchestrate tools when a task or test fails. Receives background, original prompt, all results, and failure details. Diagnoses and fixes the specific failure. Returns `<success>` or `<failure>`.
- **`human`** — Delegates tasks requiring manual human action (entering passwords, SSO access, dangerous production operations). Presents instructions to the human and awaits confirmation.

## Naming Conventions

- **Plan names**: sanitized (lowercase, underscores, 7-word max with abbreviation)
- **Task directories**: `NN-task_name` (zero-padded), in-flight: `timestamp_NN-task`, succeeded: `.timestamp_NN-task` (hidden), failed: `timestamp_NN-task.failed`
- **Tool names**: `autocode_{module}_{action}` pattern
- **Agent names**: lowercase single words
- **Prompt files**: `{agent}.prompt.md`, `{agent}.session.{id}.md`, `{agent}.result.{ts}.md`
- **Verify files**: `verify.prompt.md`, `verify.session.{id}.md`, `verify.result.{ts}.md`

## Filesystem & Permissions

- All file operations scoped to `.autocode/` via `path.join()`
- Agent permissions: `plan` (read-only), `build` (filesystem), `orchestrate` (hidden, tool-restricted)
- Input sanitization: plan name validation (alphanumeric + underscore, 7-word limit)
- Parameter validators: non-empty, max words, length, format, alphanumeric
- Use `input.worktree` (not `process.cwd()`)
