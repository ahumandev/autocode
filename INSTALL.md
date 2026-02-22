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
   bun run src/install.ts --global
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

### Manual Setup (Alternative to `install:global`)
If you prefer manual symlinks instead of the install script:

```bash
# Symlink plugin file
mkdir -p ~/.config/opencode/plugin
ln -s $(pwd)/.opencode/plugin/autocode-plugin.ts ~/.config/opencode/plugin/autocode-plugin.ts

# Symlink agents
mkdir -p ~/.config/opencode/agent
for f in .opencode/agent/*.md; do
  ln -s "$(pwd)/$f" ~/.config/opencode/agent/$(basename "$f")
done

# Symlink commands
mkdir -p ~/.config/opencode/command
for f in .opencode/command/*.md; do
  ln -s "$(pwd)/$f" ~/.config/opencode/command/$(basename "$f")
done

# Symlink tools
mkdir -p ~/.config/opencode/tool
for f in .opencode/tool/*.ts; do
  ln -s "$(pwd)/$f" ~/.config/opencode/tool/$(basename "$f")
done
```

### Uninstall
Remove symlinks from OpenCode's config:
```bash
bun run src/install.ts --uninstall
```

## Project Structure

- **src/plugin.ts** — Main plugin entry point; registers agents, commands, and tools
- **src/install.ts** — Installation script for symlinking into OpenCode config
- **src/setup.ts** — Initializes `.autocode/` directory structure in projects
- **src/agents/** — Agent definitions (plan, build, autocode, solve)
- **src/commands/** — Command definitions (analyze, review, status, etc.)
- **src/tools/** — Tool implementations (session, analyze, build)
- **.opencode/** — OpenCode plugin assets (agents, commands, tools, plugin file)
- **dist/** — Compiled JavaScript output

## Non-Standard Dependencies

- **@opencode-ai/sdk** — OpenCode SDK for plugin integration
- **@opencode-ai/plugin** — Plugin interface and types
- **gray-matter** — YAML frontmatter parsing for `.md` files
- **zod** — Schema validation for configuration and data structures

## Build Output

The build process generates:
- **dist/plugin.js** — Bundled plugin for OpenCode
- **dist/*.d.ts** — TypeScript declaration files
- **dist/*.js.map** — Source maps for debugging
