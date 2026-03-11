---
name: code_common
description: Use this skill to discover common utilities and helpers, or to understand cross-cutting concerns in this project.
---

# Common Utilities & Cross-Cutting Concerns

Shared utilities for tool response contracts, agent retry governance, task filesystem operations, and project configuration.

## Utilities

### Response Helpers (`src/utils/validation.ts`)
- **`successResponse(sid, toolName, result?)`**: Resets retry counter for the tool then returns result. Objects are JSON-serialised; strings pass through raw.
- **`retryResponse(sid, toolName, paramName, constraint, onMaxRetries?)`**: Increments retry counter; after 5 failures escalates to `onMaxRetries` (default: `abortResponse`).
- **`abortResponse(toolName, reason)`**: Stateless. Emits a `**MUST ABORT**` instruction — for system/IO failures not caused by the agent.

### Parameter Validators (`src/utils/validation.ts`)
All validators return `null` on pass or a **ready-to-return JSON error string** on failure (null-or-error-string pattern).
- **`validateNonEmpty`**: Rejects undefined, null, or blank strings.
- **`validateMaxWords`**: Splits on whitespace **and underscores** — `"foo_bar"` counts as 2 words.
- **`validateMinLength` / `validateMaxLength`**: Character-length checks after trim.
- **`validateFormat`**: Regex match; caller supplies human-readable `formatDesc` shown in error.
- **`validateHasAlphanumeric`**: Strips all non-alphanumeric chars; rejects if nothing remains. Use before sanitisation, not after.

### Identifier Formatters (`src/utils/validation.ts`)
- **`toIdentifier(value)`**: Full pipeline — trim → lowercase → replace non-alphanumeric with `_` → collapse `__+` → strip edge underscores.
- **`replaceSpecialChars`, `collapseUnderscores`, `stripEdgeUnderscores`**: Individual steps, exported for targeted use.

### Retry Tracker (`src/utils/retry-tracker.ts`)
- **`trackFailure(sid, toolName)`**: Per-session, per-tool counter stored in a module-level `Map`. Switching tools **resets** the count for that session (only one tool tracked per session at a time).
- **`resetTool(sid, toolName)`**: Called by `successResponse` — zeroes count without clearing other tools.
- **`resetSession(sid)`**: Deletes the session entry entirely; use on session teardown.
- **`MAX_RETRIES = 5`**: `shouldAbort` becomes `true` when `retriesLeft <= 0` (i.e., on the 5th failure).

### Task Filesystem Helpers (`src/utils/tasks.ts`)
- **`findNextGroup(planDir)`**: Returns the lowest `^\d{2}-` entry with **no timestamp prefix and no leading dot** — i.e., strictly pending tasks only.
- **`resolveTaskDir(worktree, planName, taskName?)`**: Searches `build/`, `failed/`, and `review/` plan locations; handles all task states (pending, in-flight, succeeded, failed, concurrent groups).
- **`collectTasks(planDir)`**: Walks plan dir, recurses into `concurrent_group` subdirs, returns `TaskInfo[]` sorted numerically by task number.
- **`extractTaskResult(messages)`**: Parses `<success>`/`<failure>` tags from the last assistant message. When **both** tags appear, the one with the **higher index wins**. No tags → graceful fallback to `{ kind: "success" }` for backward compatibility.
- **`stripTaskNameDecorations(name)`**: Removes leading dot, `YYYY-MM-DD_HH-mm-ss_` prefix, and trailing `.failed`/`.deleted` — recovers the logical task name.
- **`writeOutcomeFiles(dir, sid, content, outcome)`**: Always removes stale `success.md`/`failure.md` before writing the new outcome — prevents stale state from prior runs.
- **`formatSessionMarkdown(prompt, messages)`**: Renders session transcript to markdown; includes both `text` and `reasoning` part types.
- **`buildReviewMarkdown(planName, tasks)`**: Generates the plan completion review table + detail sections.
- **`makeTimestamp()`**: Local-time `YYYY-MM-DD_HH-mm-ss` string used as task directory prefixes.

### Configuration (`src/core/config.ts`)
- **`loadConfig(projectRoot)`**: Reads `opencode.json` → `autocode` section; strips `//` and `/* */` comments (JSONC support). Bare `catch {}` silently falls back to defaults — config errors are invisible.
- **`createConfig(worktree, overrides?)`**: Sync; used by tools that receive `worktree` from context rather than discovering `projectRoot`.
- **snake_case ↔ camelCase mapping**: JSON keys (`retry_count`, `auto_install_dependencies`, `parallel_sessions_limit`) map to TypeScript camelCase fields.
- **Defaults**: `retryCount=3`, `autoInstallDependencies=true`, `parallelSessionsLimit=4`.

### Core Types (`src/core/types.ts`)
- **`Stage`** (Zod enum): `analyze | build | review | specs` — maps to `.autocode/` subdirectory names.
- **`TaskStatus`** (Zod enum): `awaiting | busy | tested`.
- **`TaskTree`**: Groups of parallel tasks executed sequentially. Numbered dirs sort **numerically** (not alphabetically) — critical for correct ordering past task 9.
- **`TaskFailure`**: Typed failure descriptor with `failureType` discriminant (`agent_failure | task_session | test_session | test_verification | tool_error`).

## Cross-Cutting Patterns

### Tool Factory Pattern
- `createAnalyzeTools(client)` / `createBuildTools(client)` capture the SDK `Client` at plugin init via closure.
- Enables per-tool client isolation and direct testability (pass a mock client in tests).

### Unified Error Contract
- All tool `execute` functions return `{ error: "..." }` JSON on failure — never throw.
- Exception: `src/tools/session.ts` and `src/tools/orchestrate.ts` use `throwOnError: true` on SDK calls — errors propagate up uncaught.
- `src/plugin.ts` wraps `initAutocode` in `.catch(() => console.warn(...))` — plugin init failures are silent.

### Filesystem Scoping
- All file operations use `path.join(worktree, ".autocode", ...)` — never `process.cwd()`.
- `input.worktree` (from tool context) is the canonical root, not the process working directory.

**IMPORTANT**: Update `.Claude/skills/code/common/SKILL.md` whenever a common util was added or modified.
