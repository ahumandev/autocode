---
name: code_error
description: Use this skill to understand how errors are handled in this project or to find error codes or custom exceptions.
---

# Error Handling

Distributed, no-exception architecture: all tools return `{ error: "..." }` JSON; three response helpers enforce a unified contract.

## Error Handling & Logging

- **`successResponse`** (`src/utils/validation.ts`): Resets retry counter; returns result as JSON string.
- **`retryResponse`** (`src/utils/validation.ts`): Increments retry counter; escalates to `onMaxRetries` (default: `abortResponse`) after `MAX_RETRIES` (5) attempts.
- **`abortResponse`** (`src/utils/validation.ts`): Stateless; emits `{ error: "You **MUST ABORT**…" }` for system/IO failures.
- **`trackFailure` / `resetTool`** (`src/utils/retry-tracker.ts`): In-memory per-session retry counter; tracks one tool per session at a time; resets on success.
- **`failPlan`** (`src/tools/build.ts`): Internal helper; moves `.autocode/build/<plan>` → `.autocode/failed/<plan>` and writes `failure.md`; idempotent via module-level `Set`.

## Parameter Validators

All in `src/utils/validation.ts`. Each returns `null` on pass or a ready-to-return JSON retry error string on failure.

- **`validateNonEmpty`** — rejects undefined, null, or blank strings.
- **`validateMaxWords`** — splits on whitespace/underscores; rejects if word count exceeds limit.
- **`validateMinLength`** / **`validateMaxLength`** — character-length guards (post-trim).
- **`validateFormat`** — regex match; caller supplies human-readable `formatDesc` for the error message.
- **`validateHasAlphanumeric`** — strips non-alphanumeric then rejects empty result; used before identifier sanitization.

## Task-Level Failure Lifecycle

Managed inside `src/tools/orchestrate.ts` (`executeTask`):

| State | Directory name |
|---|---|
| Pending | `XX-task_name` |
| In-flight | `YYYY-MM-DD_HH-mm-ss_XX-task_name` |
| Succeeded | `.YYYY-…_XX-task_name` (dot-prefixed) |
| Failed | `YYYY-…_XX-task_name.failed` |

- On agent session error: writes `{agent}.session.{sid}.md` with error header, writes `failure.md`, renames to `.failed`.
- On test session error: writes `test.result.{ts}.md` as `<failure>…</failure>`, writes `failure.md`, renames to `.failed`.
- On success: writes `success.md` (empty), renames to dot-prefixed done directory.
- Concurrent group failure: entire group dir renamed to `{group}.failed` if any task fails.

## Notes

- **Silent failures (intentional)**:
  - `src/plugin.ts`: `initAutocode(...).catch(err => console.warn(...))` — startup directory init failure is logged but does not crash the plugin.
  - `src/core/config.ts`: bare `catch {}` on config file read — silently falls back to hardcoded defaults (`retryCount: 3`, `parallelSessionsLimit: 4`, `autoInstallDependencies: true`).
  - `src/tools/build.ts` `autocode_build_orchestrate`: fire-and-forget `.catch(() => {})` on the orchestrate session prompt — orchestrate agent handles its own failures.
  - `src/tools/orchestrate.ts` `spawnDocumentAgent` / `spawnOptimizeAgent`: wrapped in `try/catch` with empty catch — post-plan agents are best-effort.
- **No try/catch in `src/tools/session.ts`**: `spawn_session` uses `throwOnError: true` on both API calls; errors propagate unhandled to the caller.
- **Retry counter tracks only one tool per session**: `retry-tracker.ts` stores `{ tool, count }` per `sessionID`; switching to a different tool resets the count implicitly.
- **`failPlan` is best-effort**: its own `try/catch` swallows filesystem errors — callers still receive `abortResponse` even if the directory move fails.
- **No custom exception classes** anywhere in the codebase.

**IMPORTANT**: Update `.opencode/skills/code/error/SKILL.md` whenever an error code was added or modified or the error handling logic changed.
