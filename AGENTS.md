# Autocode Plugin

OpenCode plugin/library for tracked job flow, safe execution, and docs.
It turns concepts into plans, runs work in OpenCode, and keeps state in text files.

# Primary features

- **Read-only DB tools**: Inspect one table at a time.
- **Cross-project tasking**: Run isolated OpenCode sessions elsewhere.
- **SSH tool suite**: Run remote SSH and SFTP file tasks.
- **Job planner tools**: Move work through concept, draft, assist, auto, review.
- **Agent prompts**: Bundle guidance for managed agents.
- **Slash commands**: Register OpenCode commands for users.
- **Plugin install shim**: Place plugin shim at OpenCode config path.

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
- `src/tools/`: Runtime tools for jobs, DB read, sandbox, SSH, cross-project tasks, resume.
- `src/skills/`: Source guidance bundled into `dist/skills`.
- `src/install.ts`: Installs shim at `~/.config/opencode/plugins/autocode.js`.

# Rules

- Treat repo as OpenCode plugin/library, not standalone app or web server.
- Keep tool error handling aligned with `src/utils/tools.ts` and `src/agents/prompts/error.ts`.
- `AUTOCODE_SSH_{ssh_key}_HOST` is hostname or IP only; `host:port` is not parsed.
- `AUTOCODE_SSH_{ssh_key}_USERNAME` defaults to `root`.
- `AUTOCODE_SSH_{ssh_key}_PORT` sets non-default port; default `22`; valid range `1` to `65535`.
- `AUTOCODE_SSH_{ssh_key}_AGENT` is SSH agent socket/path.
- Use `AUTOCODE_SSH_{ssh_key}_AGENT` only when no readable `KEYFILE` and no `PASSWORD`.
