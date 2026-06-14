# OpenCode job workflow plugin
OpenCode plugin/library for tracked job flow, safe execution, and docs.
It turns concepts into plans, runs work in OpenCode, and keeps state in text files.

# Workflow tools

- **Read-only DB tools**: Inspect one table at a time.
- **Cross-project tasking**: Run isolated OpenCode sessions elsewhere.
- **Generated skills**: Bundle `src/skills` into `dist/skills` for OpenCode auto-load.

# Core flow or states
- Concept -> draft -> assist or auto -> review -> shelved.
- Valid job states: `concepts`, `drafts`, `assist`, `executing`, `facilitate`, `review`, `shelved`.
- `auto` jobs live in `.agents/jobs/executing/`.
- Blocked `auto` jobs move to `.agents/jobs/facilitate/`.
- `assist` jobs live in `.agents/jobs/assist/`.
- Jobs stay in `.agents/jobs/{status}/{job_name}/`.

# Architecture map
- `src/plugin.ts`: Plugin entry; registers agents, commands, tools, config, and guidance.
- `src/agents/`: Managed agents and prompts.
- `src/commands/`: Slash command registration.
- `src/tools/`: Runtime tools for jobs, DB read, sandbox, cross-project tasks, resume.
- `src/skills/`: Source guidance bundled into `dist/skills`.
- `src/install.ts`: Installs shim at `~/.config/opencode/plugins/autocode.js`.
- `bun run build`: Builds `dist/` only; does not install the shim.

# Rules
- Treat repo as OpenCode plugin/library, not standalone app or web server.
- Keep tool error handling aligned with `src/utils/tools.ts` and `src/agents/prompts/error.ts`.
