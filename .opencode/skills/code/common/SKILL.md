---
name: code_common
description: Use this skill to discover common utilities and helpers, or to understand cross-cutting concerns in this project.
---

# Common Utilities & Cross-Cutting Concerns

Shared configuration loading, domain types, filesystem scaffolding, and tool-factory patterns for the Autocode OpenCode plugin.

## Utilities

### Configuration (`src/core/config.ts`)
- **`loadConfig(projectRoot)`** (`src/core/config.ts`): Reads `opencode.json`'s `"autocode"` section with JSONC comment-stripping; silently falls back to defaults on any error.
- **`createConfig(worktree, overrides?)`** (`src/core/config.ts`): Synchronous alternative for tools that already have `worktree` from OpenCode context — avoids async I/O.
- **DEFAULTS** (`src/core/config.ts`): `retryCount=3`, `autoInstallDependencies=true`, `parallelSessionsLimit=4`. `rootDir` is always derived as `<projectRoot>/.autocode` — never configurable directly.

### Domain Types (`src/core/types.ts`)
- **`Stage`** (`src/core/types.ts`): Zod enum (`"analyze" | "build" | "review" | "specs"`) — dual-use as runtime validator and TypeScript type via `z.infer`.
- **`TaskStatus`** (`src/core/types.ts`): Zod enum (`"accepted" | "busy" | "tested"`) — maps directly to filesystem subdirectory names inside a plan.
- **`TaskTree`** (`src/core/types.ts`): Groups of tasks where each group runs in parallel but groups are sequential. Numbered dirs (`0-foo`, `1-bar`) create separate sequential groups; unnumbered dirs share one parallel group. Numeric sort is explicit to avoid `"10" < "2"` alphabetic ordering bug.
- **`SessionMeta`** (`src/core/types.ts`): Tracks OpenCode session IDs per plan and per task for resumability across interruptions.

### Filesystem Scaffolding (`src/setup.ts`)
- **`initAutocode(projectRoot, verbose?)`** (`src/setup.ts`): Idempotent — uses `stat()` guards before every `writeFile`; safe to call on every plugin startup. Creates `.gitkeep` files to preserve empty stage dirs in git.

### Plan Name Sanitization (`src/tools/build.ts`)
- **`generatePlanName(raw)`** (`src/tools/build.ts`): Pure, exported function — 7-word limit with abbreviation of overflow words to initials. Empty input → 40 random hex chars. Exported separately from the tool so it can be unit-tested without the OpenCode tool infrastructure.

### Directory Order Helpers (`src/tools/build.ts`)
- **`maxOrder(dir)`** (`src/tools/build.ts`): Internal async helper — reads highest numeric prefix (`N-`) in a directory; returns `-1` when empty. Used to auto-assign sequential task order numbers.
- **`lastEntry(dir)`** (`src/tools/build.ts`): Internal async helper — sorts entries numerically then alphabetically; detects whether the last entry is a `-(parallel)` slot to decide whether to reuse or open a new slot.

## Tool Factory Pattern (Cross-Cutting)

All tool groups use a **factory function + closure** pattern instead of module-level singletons:

```
createXxxTools(client: Client): Record<string, ToolDefinition>
```

- `createAnalyzeTools(client)` — `src/tools/plan.ts`
- `createBuildTools(client)` — `src/tools/build.ts`

The `client` (OpenCode SDK instance) is captured at plugin-init time and injected via closure. This avoids global state and makes tools independently testable. All three factories are composed in `src/plugin.ts` via spread into a single `tool:` map.

## Plugin Config Hook (Cross-Cutting)

**`plugin.ts` `config(cfg)` hook** (`src/plugin.ts`): Merges agents with **per-agent spreading** (`{ ...agentDef, ...cfg.agent[name] }`) so a user's partial override (e.g. just `model`) doesn't silently discard the plugin's `prompt` or `permissions`. Commands use a simpler spread (`{ ...commands, ...cfg.command }`) — user commands always win.

## Side-Effect on File Read

**`autocode_analyze_read`** (`src/tools/plan.ts`): Renames the current OpenCode session title to the selected filename as a side-effect of reading it. Non-obvious — the tool description does not mention this.

## Naming Discrepancy (Known Bug / Alias)

**`autocode_build_plan_name`** is the variable name in `build.ts` (line 131) but it is exported under the key **`autocode_build_validate_plan_name`** (line 349). Agent prompts and tool descriptions reference the exported name. The variable name is an internal alias only.

## Install Utility (`src/install.ts`)

**`install.ts`** (`src/install.ts`): Dev-only script — symlinks `.opencode/` agent/command/tool/plugin files into `~/.config/opencode/` for local testing. Not part of the npm package runtime; run via `bun run src/install.ts [--global|--uninstall]`.

**IMPORTANT**: Update `.opencode/skills/code/common/SKILL.md` whenever a common util was added or modified.
