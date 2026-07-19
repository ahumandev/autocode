<div align="center">
<img src="logo.webp" alt="AutoCode"/>
<p><i>The workflow engine for traceable autonomous job execution</i></p>
</div>

---

AutoCode is an OpenCode plugin that turns rough conceptual ideas into completed solutions by means of structured workflow phases and optional review gates.

Run jobs autonomously with **Auto mode**, or stay in control with **Assist mode**, where AutoCode does the safe hard work and separates dangerous operations into guided manual steps.

No special UI required. AutoCode runs in OpenCode, keeps progress in version-controllable text files, and lets you track multiple jobs across their full lifecycle making it the ideal solution for remote development or server administration.

---

## Features

- 🧭 **Structured lifecycle** — move researched work from concept to solution in phases: concept ➔ draft ➔ executing job ➔ review.
- 🔎 **Research** — safely gather read-only evidence on project or non-project topics without making changes.
- 🧠 **Design** — brainstorm options, study feasibility, compare approaches, and report pros, cons, and risks before implementation starts.
- 🤖 **Auto mode** — execute approved drafted jobs autonomously while keeping progress and review evidence in version-controllable files.
- 🧑‍💻 **Assist mode** — keep a human in control while AutoCode reads the plan, recommends next steps, and tracks implementation progress.
- 📚 **Self-learning skills** — auto capture corrections, environment quirks, permissions, and user preferences as skills for future sessions.
- ⚠️ **Safe hand-offs** — provide a thorough manual task tutorial when an operation is unsafe.
- ⚡ **Token-optimized workflows** — smart orchestrators delegate to faster specialists to improve performance and reduce token use.
- 🗄️ **Read-only database inspection** — discover configured database tables and read one table at a time without write access.
- 🧪 **Sandboxed execution** — run supported risky commands in Linux bubblewrap sandboxes when the host supports user namespaces.
- 📦 **Cross-project tasking** — delegate investigation or edits to isolated OpenCode sessions in other directories after permission checks.
- 🔐 **SSH tool suite** — run remote commands and manage files through environment-keyed tools.
- 🧹 **Agent cleanup** — agents remove temporary files and stop stray processes they started after debugging.

## Installation

### Prerequisites

- [OpenCode](https://opencode.ai) is required to load and use AutoCode.
- The npm package / plugin entry is `@ahumandev/autocode`.

#### Optional

- [Bubblewrap](https://github.com/containers/bubblewrap) is required only for Linux sandbox execution.
- [Bun](https://bun.sh) is required only to build the plugin from source or run tests.
- [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) is required only for Chrome DevTools MCP server support.

### Installation for LLM Agents

Fetch installation guide and follow it:

```bash
curl -s https://raw.githubusercontent.com/ahumandev/autocode/refs/heads/main/docs/installation.md
```

### Installation for Humans

OpenCode installs npm plugins automatically at startup when they are listed in the global plugin configuration.

Use the global OpenCode config at `~/.config/opencode/opencode.json` or `~/.config/opencode/opencode.jsonc`, then merge the plugin entry into the existing `plugin` array instead of overwriting the file.

```json
{
  "plugin": ["@ahumandev/autocode"]
}
```

If your config already contains other plugins or settings, keep them and add `@ahumandev/autocode` to the existing array.

#### Verify installation

1. Save the updated OpenCode config.
2. Start or restart OpenCode.
3. Confirm OpenCode loads AutoCode commands or agents after startup.

### Update the plugin version

To update the public package version, change the plugin entry to `@ahumandev/autocode@latest` in your OpenCode config, save the file, and restart OpenCode.

```jsonc
{
  "plugin": ["@ahumandev/autocode@latest"]
}
```

OpenCode re-installs the requested npm plugin version during startup.

### Uninstall

Remove `@ahumandev/autocode` from the OpenCode `plugin` array, save the config, and restart OpenCode.

If you previously used the repository-only shim workflow, also remove `~/.config/opencode/plugins/autocode.js` if present.

### Troubleshooting

- Confirm the config file is `~/.config/opencode/opencode.json` or `~/.config/opencode/opencode.jsonc`.
- Confirm your JSON or JSONC stays valid after merging the plugin entry.
- Confirm the plugin entry uses `@ahumandev/autocode` or `@ahumandev/autocode@latest` exactly.
- Restart OpenCode after every config change so startup installation can run again.

## Core

- [Configuration](configuration.md) — config locations, keys, model tiers, and DB/SSH environment variables.
- [Usage](usage.md) — more details on how to use AutoCode.
- [Self Learned Skills](skill.md) — reusable guidance files that extend AutoCode behavior.
- [Terminology](terminology.md) — glossary of AutoCode concepts.

## Development & Distribution

- [Development](development.md) — architecture, local setup, commands, testing, and local plugin deployment.
- [Distribution Guide](distribution.md) — distributing AutoCode on public registries.
