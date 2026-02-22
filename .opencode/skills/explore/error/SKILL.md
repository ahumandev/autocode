---
name: explore_error
description: Use this skill to understand how errors are handled in this project or to find error codes or custom exceptions.
---

# Error Handling

Errors surface as user-visible `❌ …` strings from tools; no custom exception hierarchy exists.

## Error Handling & Logging

- **Plugin init guard** (`src/plugin.ts`): `.catch()` on `initAutocode` — logs via `console.warn`, never throws to host.
- **Tool execute blocks** (`src/tools/build.ts`, `src/tools/analyze.ts`): All filesystem-mutating tool `execute()` functions wrap their body in `try/catch (err: any)` and return `❌ <message>: ${err.message}` strings to the agent instead of throwing.
- **Filesystem probes** (`src/setup.ts`, `src/tools/build.ts`, `src/tools/analyze.ts`, `src/install.ts`): `stat(…).catch(() => null)` and `readdir(…).catch(() => [])` are the canonical pattern for optional filesystem checks — they swallow ENOENT silently.
- **Config loading** (`src/core/config.ts`): Bare `catch {}` on `readFile`/`JSON.parse` — any failure silently falls back to `DEFAULTS`. No error is logged.
- **Install/uninstall CLI** (`src/install.ts`): Per-symlink `try/catch`; failures logged via `console.error` with `❌` prefix; execution continues for remaining links.
- **CLI entry point** (`src/setup.ts` `import.meta.main`): Top-level `.catch` calls `console.error` then `process.exit(1)`.
- **SDK calls** (`src/tools/session.ts`, `src/tools/analyze.ts`): `throwOnError: true` passed to all OpenCode SDK client calls — SDK errors propagate as thrown exceptions (caught by the tool's outer `try/catch` where present, or bubble to the plugin host).

## Error-Related Types

- **`TaskExecutionResult.error`** (`src/core/types.ts` line 129): Optional string field on task results — populated when a task agent run fails.
- **`TaskSessionInfo.lastError`** (`src/core/types.ts` line 55): Persisted last error string per task; used alongside `retryCount` to track retry state.
- **`AutocodeConfig.retryCount`** (`src/core/types.ts` line 12): Max retry attempts before escalating a failed task to human review.

## Notes

- There are **no custom exception classes** — errors are represented as plain strings in tool return values or as native `Error` objects from the runtime/SDK.
- Tool return values use a consistent emoji convention: `✅` for success, `❌` for failure. Agents parse these strings to determine next steps.
- The `## Error Recovery` block injected into every `build.prompt.md` (`src/agents/prompts/build.ts` lines 130–137) instructs the solve agent to self-heal common errors (missing deps, bad imports, missing config) without asking for help.
- `throwOnError: true` on SDK calls means a network or API error in `spawn_session` or `autocode_analyze_read` will propagate uncaught unless the caller wraps it — `autocode_analyze_read` does wrap it; `spawn_session` does not.
- Config parse errors are silently swallowed (`src/core/config.ts`); a malformed `opencode.json` will produce no warning and fall back to defaults.

**IMPORTANT**: Update `.Claude/skills/explore/error/SKILL.md` whenever an error code was added or modified or the error handling logic changed.
