---
name: code_common
description: Use this skill to discover common utilities and helpers, or to understand cross-cutting concerns in this project.
---

# Common Utilities & Cross-Cutting Concerns

Validation, error formatting, and string-normalization helpers shared across all tool implementations.

## Utilities

### Response Helpers (`src/utils/validation.ts`)

Three functions cover every possible tool return path. All return a `string` (JSON or plain text) ready to `return` directly from `execute`.

- **`successResponse(sessionID, toolName, result?)`** — Resets the retry counter for the tool, then returns `result` serialised. Objects are `JSON.stringify`-ed; strings pass through unchanged. Default `result` is `{ success: true }`. **Always call this on success** so a later failure starts from zero retries.

- **`retryResponse(sessionID, toolName, paramName, constraint, onMaxRetries?)`** — Increments the retry counter via `trackFailure`. Returns `{ error: "Retry <toolName> again with a valid <paramName> parameter which must <constraint>" }`. Once `MAX_RETRIES` (5) is reached, calls `onMaxRetries()` instead — default escalates to `abortResponse`. Use for **agent-correctable** parameter errors.

- **`abortResponse(toolName, reason)`** — Stateless. Returns `{ error: "You **MUST ABORT** your workflow immediately and prompt the user to investigate the failure of the tool call '<toolName>' with reason: <reason>" }`. Use for **system/IO failures** that the agent cannot fix by retrying.

### Retry Tracker (`src/utils/retry-tracker.ts`)

Module-level `Map` keyed by `sessionID`. Each session stores **one** `{ tool, count }` entry — switching to a different `toolName` implicitly resets the count to 0 for that new tool.

- **`MAX_RETRIES`** — `5`. Exported constant; `shouldAbort` becomes `true` when `retriesLeft <= 0`.
- **`trackFailure(sessionID, toolName)`** — Increments count, returns `{ retriesLeft, shouldAbort }`. Called internally by `retryResponse`; do not call directly from tools.
- **`resetTool(sessionID, toolName)`** — Zeroes the count for a specific tool. Called internally by `successResponse`.
- **`resetSession(sessionID)`** — Deletes the session entry entirely. Useful in tests.
- **`getStatus(sessionID, toolName)`** — Read-only status check; does not mutate state.

> **Gotcha:** only one tool is tracked per session at a time. If a tool calls `retryResponse` for `tool-a` twice, then `retryResponse` for `tool-b` once, the `tool-a` count is lost. Counts are per-(session, most-recent-tool) pair, not per-(session, tool) pair.

### Parameter Validators (`src/utils/validation.ts`)

Each validator returns **`null` on pass** or a **complete JSON error string on failure** (ready to `return` from `execute`). All failures route through `retryResponse`, so they automatically participate in retry escalation.

| Function | Key behaviour |
|---|---|
| `validateNonEmpty(value, sid, toolName, paramName)` | Fails if `undefined`, `null`, or blank after trim |
| `validateHasAlphanumeric(value, sid, toolName, paramName)` | Strips all non-alphanumeric chars; fails if nothing remains — run **before** `toIdentifier` to catch all-symbol inputs |
| `validateMaxWords(value, maxWords, sid, toolName, paramName)` | Splits on whitespace **and underscores** — `"foo_bar_baz"` counts as 3 words |
| `validateMinLength(value, minLength, sid, toolName, paramName)` | Checks trimmed length |
| `validateMaxLength(value, maxLength, sid, toolName, paramName)` | Checks trimmed length |
| `validateFormat(value, pattern, formatDesc, sid, toolName, paramName)` | Tests `pattern.test(value)`; `formatDesc` appears verbatim in the error message |

### Parameter Formatters (`src/utils/validation.ts`)

Pure string transforms with no side effects. Intended to be composed in order.

- **`toIdentifier(value)`** — Full pipeline: trim → lowercase → replace non-alphanumeric with `_` → collapse consecutive `_` → strip leading/trailing `_`. Produces a safe filesystem/identifier token.
- **`toLowercase(value)`** — `value.toLowerCase()`.
- **`replaceSpecialChars(value, replacement?)`** — Replaces every non-`[a-z0-9]` char with `replacement` (default `_`). Assumes input is already lowercased.
- **`collapseUnderscores(value)`** — Collapses `__+` to a single `_`.
- **`stripEdgeUnderscores(value)`** — Removes leading and trailing `_`.

---

## Standard Tool Execute Pattern

Every tool `execute` function follows this exact structure:

```
1. const sid = context.sessionID
2. Run validators in order, returning early on non-null:
     const err = validateXxx(args.foo, sid, "tool_name", "foo")
     if (err) return err
3. Perform business logic / IO inside try/catch:
     - On IO success:  return successResponse(sid, "tool_name", payload)
     - On agent error: return retryResponse(sid, "tool_name", "param", "constraint")
     - On system error: return abortResponse("tool_name", err.message)
```

`build.ts` tools that touch the filesystem also call `failPlan()` before `abortResponse` to move the plan directory to `.autocode/failed/` as a best-effort cleanup step.

Note: `autocode_analyze_list` has no `sid` / validators because it takes no parameters; it uses `abortResponse` directly for IO errors.

---

**IMPORTANT**: Update `.opencode/skills/code/common/SKILL.md` whenever a common util was added or modified.
