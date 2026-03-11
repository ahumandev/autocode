# Security Architecture

## Overview

Autocode is a file-based workflow orchestrator plugin for OpenCode with minimal security surface. It operates entirely within the user's local project directory (`.autocode/`) and delegates all authentication and authorization to OpenCode's permission system. No network exposure, no credential handling, and no user authentication logic.

## Key Components

- [Agent Permissions](./src/agents/index.ts) - Tool access control via OpenCode's permission system
- [Input Sanitization](./src/tools/build.ts) - Plan name validation (7-word limit, alphanumeric + underscore, timestamp deduplication)
- [Parameter Validators](./src/utils/validation.ts) - Non-empty, max-words, length, format, alphanumeric checks
- [Retry & Error Handling](./src/utils/retry-tracker.ts) - Distributed error handling with max-retry escalation (5 retries)
- [Configuration](./src/core/config.ts) - JSONC parsing with regex comment stripping; safe defaults on missing/invalid files

## Authentication

**Not applicable.** Autocode has no authentication logic. All user identity and session management is handled by OpenCode itself. The plugin receives an authenticated `client` instance from OpenCode's plugin context and uses it to create and manage sessions within OpenCode's infrastructure.

## Authorization

Autocode uses **OpenCode's permission system** to restrict agent access to specific tools. Each agent declares a `permission` object that controls which tools it can invoke.

### Agent Permissions

Defined in [`src/agents/index.ts`](./src/agents/index.ts):

- **plan** (read-only): `autocode_analyze*`, `grep`, `read`, `question`, `webfetch`, `plan_exit`, `submit_plan`, `task` (with restrictions)
- **build** (filesystem only): `autocode_build*`, `question`, `plan_enter`
- **orchestrate** (hidden): `autocode_orchestrate*` only — no direct filesystem access
- **human** (delegation): `question` only — for manual SSO/password/production operations
- **report** (read-only): Query and reporting tools; denies code execution

## Security Features

- **Filesystem Scoping**: All file operations scoped to `.autocode/` via `path.join(input.worktree, ".autocode", ...)` — never writes outside
- **Plan Name Sanitization** ([`generatePlanName()`](./src/tools/build.ts#L35)): 
  - Lowercase, non-alphanumeric → underscore, collapse consecutive underscores, strip edges
  - 7-word limit; words 8+ abbreviated to first letter and concatenated
  - Timestamp suffix (`_${Date.now()}`) if directory exists (deduplication)
  - Validation: non-empty + alphanumeric check before sanitization
- **Parameter Validators** ([`src/utils/validation.ts`](./src/utils/validation.ts)): Non-empty, max-words, min/max-length, format (regex), alphanumeric
- **Retry Tracking** ([`src/utils/retry-tracker.ts`](./src/utils/retry-tracker.ts)): Max 5 retries per tool per session; escalates to abort on max exceeded
- **Unified Error Responses**: All tools return `{ error: "..." }` JSON on failure; no custom exceptions
- **No Network Calls**: All external calls go through OpenCode client API (no direct HTTP)
- **No Credential Handling**: Plugin never stores, logs, or transmits secrets

## Non-Standard Practices

- **Silent Failures on Init**: `src/plugin.ts` `.catch()` on `initAutocode` → `console.warn` (non-blocking). `src/core/config.ts` bare `catch {}` falls back to safe defaults. Acceptable because `.autocode/` directory creation is idempotent and config files are user-controlled.

- **Session Tool Error Propagation**: `src/tools/session.ts` uses `throwOnError: true` (no try/catch) — errors bubble up to OpenCode. Acceptable because session creation/prompting is a system-level operation; failures should be visible.

- **Orchestrate Tool Fire-and-Forget**: `autocode_build_orchestrate` spawns orchestrate agent without awaiting the prompt call; `.catch()` silently ignores errors. Acceptable because the orchestrate agent runs independently and handles its own failures.

- **JSONC Comment Stripping**: Regex-based comment removal instead of dedicated parser. May fail on edge cases (comments inside strings). Acceptable because config files are user-controlled and not untrusted input.

- **Path Traversal Prevention via Naming Convention**: Filesystem safety relies on sanitized plan/task names and explicit `path.join()` calls rather than canonicalization. Safe because:
  - Plan names generated/validated by build agent (trusted)
  - Task names provided by build agent (trusted)
  - No user-supplied paths used directly in filesystem operations
  - All paths constructed relative to `.autocode/` directory

## Configuration

Autocode reads optional configuration from `opencode.json` under the `autocode` section:

```jsonc
{
  "autocode": {
    "retry_count": 3,                      // Max retries before escalation
    "auto_install_dependencies": true,     // Auto-install on failure
    "parallel_sessions_limit": 4           // Max concurrent SDK sessions
  }
}
```

If `opencode.json` is missing or invalid, safe defaults are used. No secrets should be stored in this file.
