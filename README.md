# Autocode

A file-based workflow orchestrator for [OpenCode](https://opencode.ai). Enables fire-and-forget AI task execution: approve a plan, walk away, and come back to review results.

## How It Works

Autocode introduces a structured workflow with 4 stages:

```
.autocode/
├── analyze/    # Add your idea .md files here
├── build/      # Plans being converted to tasks and executed
├── review/     # Completed plans awaiting your review
├── specs/      # Approved specs (registered as OpenCode skills)
└── .archive/   # Historical plan directories
```

### Workflow

1. **Analyze** — Add idea `.md` files to `.autocode/analyze/`
2. **Plan** — Run `/autocode-analyze` → interactive planning with OpenCode's plan agent
3. **Build** — Plan approval generates task directory structure with `build.prompt.md` and `test.prompt.md` files
4. **Orchestrate** — Autocode agent executes tasks sequentially/concurrently, retries failures, exports session logs
5. **Review** — Run `/autocode-review` → approve or reject completed work
6. **Specs** — Approved plans become OpenCode skills under `/plan-*` for future reference

## Installation

### Option A: Local Installation (Development)

Install directly from your local folder without publishing to npm:

**1. Clone or copy the autocode project:**
```bash
git clone <repo> ~/path/to/autocode
# or just use your local development copy
```

**2. Install dependencies:**
```bash
cd ~/path/to/autocode
npm install
```

**3. Add to your global OpenCode config (`~/.config/opencode/opencode.jsonc`):**

```jsonc
{
  // ... your existing config ...

  // Autocode agents
  "agent": {
    "build": {
      "mode": "primary",
      "description": "Converts approved plans into autocode task structure.",
      "prompt": "{file:~/path/to/autocode/.opencode/agent/build.md}"
    },
    "autocode": {
      "mode": "primary",
      "description": "Autocode orchestrator.",
      "prompt": "{file:~/path/to/autocode/.opencode/agent/autocode.md}",
      "tools": { "write": true, "edit": true, "bash": true, "task": true, "question": true },
      "permission": { "edit": "allow", "bash": { "*": "allow" }, "task": { "solve": "allow", "test": "allow", "*": "deny" } }
    },
    "solve": {
      "mode": "subagent",
      "description": "Executes coding instructions.",
      "prompt": "{file:~/path/to/autocode/.opencode/agent/solve.md}",
      "tools": { "write": true, "edit": true, "bash": true, "task": false, "question": false },
      "permission": { "edit": "allow", "bash": { "*": "allow" } }
    }
  },

  // Autocode commands
  "command": {
    "autocode-analyze": {
      "description": "Scan .autocode/analyze/ and start planning",
      "agent": "build",
      "template": "{file:~/path/to/autocode/.opencode/command/autocode-analyze.md} $ARGUMENTS"
    },
    "autocode-resume": {
      "description": "Resume an interrupted autocode orchestration",
      "agent": "autocode",
      "template": "{file:~/path/to/autocode/.opencode/command/autocode-resume.md} $ARGUMENTS"
    },
    "autocode-review": {
      "description": "Review completed plans",
      "agent": "autocode",
      "template": "{file:~/path/to/autocode/.opencode/command/autocode-review.md} $ARGUMENTS"
    },
    "autocode-status": {
      "description": "Show status of all autocode stages",
      "agent": "autocode",
      "template": "{file:~/path/to/autocode/.opencode/command/autocode-status.md} $ARGUMENTS"
    },
    "autocode-abort": {
      "description": "Emergency abort all running autocode tasks",
      "agent": "autocode",
      "template": "{file:~/path/to/autocode/.opencode/command/autocode-abort.md} $ARGUMENTS"
    },
    "autocode-init": {
      "description": "Initialize .autocode/ directory structure",
      "agent": "build",
      "template": "{file:~/path/to/autocode/.opencode/command/autocode-init.md} $ARGUMENTS"
    }
  },

  // Grant plan/analyze/explore agents access to plan/* skills
  "permission": {
    "skill": {
      "plan-*": "allow"
    }
  }
}
```

**4. Initialize autocode in your project:**
```bash
cd your-project
opencode  # start OpenCode
# Then run: /autocode-init
```

### Option B: Install as OpenCode Plugin (Auto-discovery)

OpenCode auto-discovers plugins from `~/.config/opencode/plugin/` or `.opencode/plugin/`. 

**1. Symlink the plugin file:**
```bash
mkdir -p ~/.config/opencode/plugin
ln -s ~/path/to/autocode/.opencode/plugin/autocode-plugin.ts ~/.config/opencode/plugin/autocode-plugin.ts
```

**2. Symlink agent, command, and tool directories:**
```bash
# Agents
mkdir -p ~/.config/opencode/agent
for f in ~/path/to/autocode/.opencode/agent/*.md; do
  ln -s "$f" ~/.config/opencode/agent/$(basename "$f")
done

# Commands
mkdir -p ~/.config/opencode/command
for f in ~/path/to/autocode/.opencode/command/*.md; do
  ln -s "$f" ~/.config/opencode/command/$(basename "$f")
done

# Tools
mkdir -p ~/.config/opencode/tool
for f in ~/path/to/autocode/.opencode/tool/*.ts; do
  ln -s "$f" ~/.config/opencode/tool/$(basename "$f")
done
```

### Option C: Install Script

Run the provided install script:
```bash
cd ~/path/to/autocode
bun run src/install.ts --global
```

This will automatically symlink all files to `~/.config/opencode/`.

### Future: npm Installation (Once Published)

Once published to npm, installation will be:
```bash
# Add to opencode.jsonc plugin array:
{
  "plugin": ["autocode@latest"]
}
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/autocode-init` | Initialize `.autocode/` directory in current project |
| `/autocode-analyze` | Pick an idea from `.autocode/analyze/` and start planning |
| `/autocode-resume` | Resume an interrupted build orchestration |
| `/autocode-review` | Review completed plans (approve/reject) |
| `/autocode-status` | Show status of all stages |
| `/autocode-abort` | Emergency abort all running tasks |

### Task Directory Structure

```
.autocode/build/<plan_name>/
├── plan.md              # Approved plan content
├── .review.md           # Review instructions (hidden until review)
├── .session.json        # Session IDs for resumability
├── accepted/            # Tasks not yet started
│   ├── 0-first_task/    # Numbered = sequential (runs after all lower numbers)
│   │   ├── build.prompt.md
│   │   └── test.prompt.md
│   ├── 1-second_task/
│   │   ├── build.prompt.md
│   │   ├── test.prompt.md
│   │   ├── parallel_a/  # Unnumbered = parallel (runs concurrently)
│   │   └── parallel_b/  # Unnumbered = parallel (runs concurrently)
│   └── 2-third_task/
├── busy/                # Currently executing
└── tested/              # Completed & verified
```

### Task Ordering Rules

- **Numbered directories** (`0-xxx`, `1-xxx`, `2-xxx`, ..., `10-xxx`) execute **sequentially** in numeric order
- **Unnumbered directories** (no numeric prefix) execute **in parallel** with their siblings
- Sorting is **numeric** (0, 1, 2, ..., 9, 10, 11) — not alphabetic

## Architecture

```
User
  ↓
/autocode-analyze
  ↓
plan agent (interactive) → plan_exit → build agent (task generator)
                                              ↓
                                       autocode agent (orchestrator)
                                              ↓
                                    ┌─────────────────┐
                                    │  solve (build)  │ → test agent
                                    │  (concurrent    │    (sequential
                                    │   for parallel  │     per task)
                                    │   tasks)        │
                                    └─────────────────┘
                                              ↓
                                       review → approve
                                              ↓
                                    git commit + spec + skill
```

## Development

```bash
# Install dependencies
npm install

# Run tests
bun test

# Type check
npx tsc --noEmit

# Initialize in a project
bun run src/setup.ts /path/to/project
```
