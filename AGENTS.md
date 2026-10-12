# Purpose of project

OpenCode plugin for reusable skills and safe tool execution.
OpenCode sessions own workflow and state.

## Primary features

- **`/learn`**: Retains corrections, environment quirks, permissions, and preferences as skills.
- **Builtin bundled skills**: Provides reusable skills bundled from `src/skills`.
- **SSH tool suite**: Runs remote commands and manages files through environment-keyed tools.

## Architecture map

- `src/plugin.ts`: Plugin entry; registers agents, commands, tools, skills, config, and guidance.
- `src/agents/`: Managed agents and prompts.
- `src/commands/`: Slash command registration.
- `src/tools/`: Retained runtime tools.
- `src/skills/`: Source guidance bundled into `dist/skills`.
- `src/install.ts`: Installs shim at `~/.config/opencode/plugins/autocode.js`.

## Rules

- Treat repo as OpenCode plugin/library, not standalone app or web server.
- Keep tool error handling aligned with `src/utils/tools.ts` and `src/agents/prompts/error.ts`.
- Keep source, runtime, and build skills local-only: only bundled AutoCode skills from `src/skills`; no GitHub skill acquisition, packaging, or snapshots.
- Preserve external/user skill folders; never delete or modify them.
