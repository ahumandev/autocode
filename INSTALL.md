# Installation

## Prerequisites

- **Bun** (latest) — JavaScript runtime and package manager
- **Node.js** (v18+) — For TypeScript compilation
- **OpenCode** — The plugin target platform

## Setup Steps

1. Install dependencies:
   ```bash
   bun install
   ```

2. Build the plugin:
   ```bash
   bun run build
   ```

3. Install into OpenCode's global config directory:
   ```bash
   bun run install:global
   ```
   This creates symlinks in `~/.config/opencode/` for agents, commands, tools, and the plugin file.

## Running Tests

```bash
bun test
```

## Type Checking

```bash
bun run typecheck
```

## Development Workflow

### Watch Mode
Rebuilds TypeScript and watches for changes:
```bash
bun run watch
```

### Uninstall
Remove symlinks from OpenCode's config:
```bash
bun run uninstall:global
```

## Autocode Workflow

Autocode is a fire-and-forget AI task orchestration system. Once installed, it provides two main commands:

### `/autocode-analyze` — Plan Creation
1. User creates an idea file in `.autocode/analyze/` (e.g., `hello_world.md`)
2. User runs `/autocode-analyze` → launches the **plan agent**
3. Plan agent discovers idea files, reads content, interviews user, researches constraints
4. Plan agent proposes a solution and writes a full plan with `<plan_name>` tag
5. User approves plan → plan agent calls `plan_exit` → hands off to **build agent**
6. Build agent creates `.autocode/build/{plan_name}/plan.md` and numbered task directories with prompt files
7. Build agent spawns **orchestrate agent** (fire-and-forget)

### Orchestrate Agent — Task Execution
The orchestrate agent automatically:
1. Loops through each task directory in order
2. Spawns the appropriate agent (code, browser, git, etc.) with execution instructions
3. Spawns a **test agent** to verify the work
4. On task completion, moves to the next task
5. On all tasks complete, generates `review.md` and moves plan to `.autocode/review/`

### Plan Review & Approval
1. User runs `/autocode-review` to review completed plans
2. User approves or rejects results
3. Approved plans move to `.autocode/specs/`
4. Failed plans move to `.autocode/failed/`

## Directory Structure

The plugin automatically initializes this structure in any project:

```
.autocode/
├── analyze/      — User-created idea .md files
├── build/        — Active plans with task directories
│   └── {plan_name}/
│       ├── plan.md
│       ├── 01-task_name/
│       │   ├── {agent}.prompt.md
│       │   ├── test.prompt.md
│       │   └── {agent}.result.*.md
│       └── 02-task_name/
├── review/       — Completed plans awaiting manual review
├── specs/        — Approved specs (also registered as OpenCode skills)
├── failed/       — Failed plans
├── .archive/     — Historical plan directories
└── README.md     — Quick start guide
```

## Non-Standard Dependencies

- **@opencode-ai/sdk** — OpenCode SDK for plugin integration
- **@opencode-ai/plugin** — Plugin interface and types
- **gray-matter** — YAML frontmatter parsing for `.md` files
- **zod** — Schema validation for configuration and data structures
