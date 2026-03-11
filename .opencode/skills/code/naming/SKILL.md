---
name: code_naming
description: Naming new files, classes, functions, variables, or identifiers in the autocode project
---

# Naming Conventions

## Plan Names

**Why:** Sanitize user input into safe, filesystem-compatible directory names while preserving readability.

**Pattern:**
- Lowercase all letters
- Replace non-alphanumeric characters with underscores
- Collapse consecutive underscores to single underscore
- Strip leading/trailing underscores
- Limit to 7 words; words 8+ abbreviated to first letter and joined as 8th token
- If directory exists, append `_<timestamp>` for deduplication

**Example:**
```
Input: "Create Hello World Script"
Output: "create_hello_world_script"

Input: "Build Test Deploy Verify Check Status Report"
Output: "build_test_deploy_verify_check_status_report"

Input: "Build Test Deploy Verify Check Status Report Summary"
Output: "build_test_deploy_verify_check_status_r_bctdvcs"
```

## Task Directory Names

**Why:** Enforce sequential ordering and clear task identification in plan execution.

**Pattern:**
- Sequential tasks: `NN-task_name` (NN = zero-padded 2-digit order index)
- Concurrent groups: `NN-concurrent_group` (NN = zero-padded 2-digit order index)
- In-flight tasks: prefixed with `YYYY-MM-DD_HH-mm-ss_` timestamp (local time)
- Completed tasks: hidden with leading dot `.YYYY-MM-DD_HH-mm-ss_NN-task_name`
- Failed tasks: `.failed` suffix `YYYY-MM-DD_HH-mm-ss_NN-task_name.failed`

**Example:**
```
Pending sequential:  00-setup_dependencies
Pending concurrent:  01-concurrent_group
In-flight:          2025-03-09_14-30-45_02-run_tests
Completed:          .2025-03-09_14-30-45_02-run_tests
Failed:             2025-03-09_14-30-45_02-run_tests.failed
```

## Tool Names

**Why:** Establish consistent, predictable tool naming across the plugin.

**Pattern:** `autocode_{module}_{action}` (all lowercase, underscores between parts)

**Example:**
```
autocode_analyze_list
autocode_analyze_read
autocode_build_plan
autocode_build_next_task
autocode_build_concurrent_task
autocode_build_orchestrate
autocode_build_fail
```

## Agent Names

**Why:** Identify agent types consistently in prompts, sessions, and configuration.

**Pattern:** Lowercase single words (no underscores or hyphens)

**Example:**
```
plan, build, orchestrate, recover, code, test, human, git, md, document
```

## Prompt and Session Files

**Why:** Distinguish file types and associate sessions with specific agents.

**Pattern:**
- Prompt files: `{agent_name}.prompt.md` or `test.prompt.md`
- Session files: `{agent_name}.session.{id}.md` or `test.session.{id}.md`
- Result files: `{agent_name}.result.{ts}.md` or `test.result.{ts}.md`
- State markers: `success.md`, `failure.md`, `background.md` (empty or content files)

**Example:**
```
code.prompt.md
code.session.abc123def456.md
code.result.1741000000000.md
test.prompt.md
test.session.xyz789.md
success.md
failure.md
background.md
```

## TypeScript Code Naming

**Why:** Follow standard TypeScript conventions while maintaining consistency with JSON config keys.

**Pattern:**
- Variables, functions, methods: camelCase
- Classes, interfaces, types: PascalCase
- Constants: UPPER_SNAKE_CASE
- Private/internal functions: camelCase with leading underscore (e.g., `_helper()`)

**Example:**
```typescript
const MAX_RETRIES = 5
const planName = "my_plan"
function generatePlanName(raw: string) { }
interface TaskInfo { }
class TaskExecutor { }
```

## JSON Configuration Keys

**Why:** Maintain snake_case in JSON for consistency with OpenCode config conventions.

**Pattern:** snake_case for all JSON keys (TypeScript code converts to camelCase via mapping)

**Example:**
```json
{
  "retry_count": 3,
  "auto_install_dependencies": true,
  "parallel_sessions_limit": 4
}
```

## File Naming

**Why:** Ensure consistency and clarity in source organization.

**Pattern:**
- Source files: kebab-case (e.g., `build.ts`, `retry-tracker.ts`)
- Test files: `{name}.test.ts`
- Prompt files: `{agent_name}.prompt.md`
- Configuration: `config.ts`, `types.ts`

**Example:**
```
src/tools/build.ts
src/utils/retry-tracker.ts
src/utils/retry-tracker.test.ts
src/agents/prompts/plan.ts
```
