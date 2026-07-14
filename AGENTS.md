# Autocode Plugin

OpenCode plugin/library for tracked job flow, safe execution, and docs.
It turns concepts into plans, runs work in OpenCode, and keeps state in text files.

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
- Tool `execute` functions MUST use the 2-arg signature `execute(args, context)` and resolve relative paths via `context.directory` (the session project dir), never `process.cwd()`. `process.cwd()` is the OpenCode host cwd, not the user's project, so relative globs scan the wrong base.
