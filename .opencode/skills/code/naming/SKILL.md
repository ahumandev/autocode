---
name: code_naming
description: Naming identifiers, files, directories, tools, tasks, or configuration properties in autocode
---

# Naming Conventions

## Tool Factory Functions and Exports

**Why:** Distinguishes factory functions (TypeScript) from exported tool names (OpenCode SDK), which use different casing conventions.

**Pattern:**
- Factory functions: `create[Domain]Tools()` (camelCase)
- Exported tool names: `[domain]_[action]` (snake_case with domain prefix)
- Domain prefixes: `spawn_`, `autocode_analyze_`, `autocode_build_`

**Example:**
```typescript
export function createSessionTools(client: Client): Record<string, ToolDefinition> {
    const spawn_session = tool({ ... })
    return { spawn_session }
}

export function createAnalyzeTools(client: Client): Record<string, ToolDefinition> {
    const autocode_analyze_list = tool({ ... })
    const autocode_analyze_read = tool({ ... })
    return { autocode_analyze_list, autocode_analyze_read }
}
```

## Plan and Task Names

**Why:** Plans and tasks are user-facing workflow entities stored in `.autocode/` directories with specific ordering and parallelization semantics.

**Pattern:**
- Plan names: `lowercase_underscore` (e.g., `setup_deps`, `add_auth`)
- Task names: `lowercase_underscore` (e.g., `install_auth_deps`, `login_endpoint`)
- Sequential task directories: `<order>-<task_name>` (e.g., `0-setup_deps`, `1-create_user_model`)
- Parallel task slot: `<order>-(parallel)` with subtasks as subdirectories
- Max 7 words; words 8+ abbreviated to first letter and concatenated as 8th token

**Example:**
```
.autocode/build/add_auth/
├── plan.md
├── accepted/
│   ├── 0-install_auth_deps/
│   ├── 1-create_user_model/
│   └── 2-(parallel)/
│       ├── login_endpoint/
│       ├── register_endpoint/
│       └── logout_endpoint/
```

## Configuration Property Naming

**Why:** TypeScript interfaces use camelCase; JSON config files use snake_case per JSON conventions.

**Pattern:**
- TypeScript interface: `camelCase` (e.g., `retryCount`, `autoInstallDependencies`)
- JSON config keys: `snake_case` (e.g., `retry_count`, `auto_install_dependencies`)

**Example:**
```typescript
// TypeScript interface
export interface AutocodeConfig {
  retryCount: number
  autoInstallDependencies: boolean
  parallelSessionsLimit: number
}

// JSON config (opencode.json)
{ "autocode": { "retry_count": 3, "auto_install_dependencies": true } }
```

## Prompt and Session Files

**Why:** Distinguishes workflow files (build.prompt.md, test.session.md) from metadata files (.review.md, .session.json) using dot-prefix convention.

**Pattern:**
- Prompt files: `<agent>.prompt.md` (e.g., `build.prompt.md`, `test.prompt.md`)
- Session files: `<agent>.session.md` (e.g., `build.session.md`, `test.session.md`)
- Metadata files: dot-prefixed (e.g., `.review.md`, `.session.json`)

**Example:**
```
task_directory/
├── build.prompt.md      ← build agent instructions
├── test.prompt.md       ← test agent instructions
├── build.session.md     ← build execution output
└── test.session.md      ← test execution output

plan_directory/
├── .review.md           ← human review instructions
└── .session.json        ← session metadata
```

## Commands and Agents

**Why:** Commands use kebab-case for CLI visibility; agents use lowercase for internal registry keys.

**Pattern:**
- Commands: `kebab-case` (e.g., `autocode-analyze`, `autocode-resume`)
- Agents: `lowercase` (e.g., `plan`, `build`)

**Example:**
```typescript
// Commands (user-facing)
export const commands: CommandMap = {
    "autocode-analyze": { ... },
    "autocode-resume": { ... },
}

// Agents (internal registry)
export const agents: AgentMap = {
    plan: { ... },
    build: { ... },
}
```
