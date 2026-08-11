## Features

### Implementation Modes

- 🤖 **Auto mode** — *autonomous*: agent oversee full lifecycle of structured jobs until completion.
- 🧑‍💻 **Assist mode** — *interactive*: you make decisions, agent orchestration do the work, manage job lifecycle and suggest next steps.
- 🎓 **Teach mode** — *manual*: agents discover solutions, then guide manual implementation with step-by-step tutorials.

### Workflow Optimizations

- 📦 **Cross-project tasking** — delegate investigation or edits to isolated OpenCode sessions in external directories.
- 🪙 **Cost-saving workflows** — improve performance and reduce token usage with smart orchestration, tiered agent models, Caveman English.
- 🔒 **Secret-safe tools** — agents never see passwords or secrets; predefined keys resolve credentials at tool runtime.
- ⚠️ **Safe hand-offs** — provide a thorough manual task tutorial when an operation is unsafe.
- 📚 **Self-learning memory** — auto capture corrections, environment quirks, permissions, and user preferences as skills for future sessions.
- 🧹 **Agent cleanup** — agents remove temporary files and stop stray processes they started after debugging.

### Build-in Tools

- 🗄️ **Read-only database inspection** — discover configured database tables and read one table at a time without write access.
- 🌐 **HTTP REST client** — simulate API calls for troubleshooting.
- 🧪 **Sandbox isolation** — agents automatically manage and experiment in their own isolated sandboxes.
- 🔐 **SSH tools** — run remote commands and manage files through environment-keyed tools.
- 🔀 **Git tools** — inspect changes and commit updates to Git repositories.

As well as [OpenCode bundled tools](https://opencode.ai/docs/tools/).

## Installation

* AI agents: follow installation at [installation guide](installation.md).
* Humans: Continue to read.

### Prerequisites

- [OpenCode](https://opencode.ai) is required to load and use AutoCode.
- The npm package / plugin entry is `@ahumandev/autocode`.
- Use native CMD on Windows; use Bash on Linux.
- [Bubblewrap](https://github.com/containers/bubblewrap) is optional on Linux for sandbox execution. It is not used on Windows.
- [Bun](https://bun.sh) is needed only to build from source or install repository shim scripts.

#### Optional

- Linux sandbox execution needs Bubblewrap and host user namespaces.
- Windows does not use Bubblewrap. Sandbox agents and sandbox tools are not registered there.
- Bun build and local shim installation scripts are cross-platform Bun scripts; Bun is not needed for public plugin installation.

### Installation for Humans

Run this in native CMD on Windows or Bash on Linux:

```text
opencode plugin -g @ahumandev/autocode@latest
```

OpenCode loads global plugins at startup. Default config directory is `<home>/.config/opencode`; `OPENCODE_CONFIG_DIR` overrides it, then `XDG_CONFIG_HOME/opencode` applies when `OPENCODE_CONFIG_DIR` is unset.

Start or restart OpenCode, then run `/install`. It checks and remediates Windows dependencies only. On Linux, install Bubblewrap separately when sandbox execution is needed. Generated skills are stored in `<home>/.agents/skills`.

#### Verify installation

1. Start or restart OpenCode after installation.
2. Run `/install`.
3. Confirm AutoCode commands or agents load after startup.
4. Confirm generated skills appear in `<home>/.agents/skills/autocode` after first startup.

### Linux MCP setup

Use these optional MCP servers only on Linux. Add each command or URL to MCP client configuration; do not globally install packages.

#### Chrome DevTools MCP

Install current Google Chrome and Node LTS with npm. Use this local server command:

```bash
npx -y chrome-devtools-mcp@latest
```

For a sandbox or container, start Chrome with a remote-debugging port and a non-default profile directory:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.cache/chrome-devtools-mcp"
```

Then use this server command:

```bash
npx -y chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222
```

See [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) and its [troubleshooting guide](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md).

#### Context7 MCP

Context7 local mode needs Node `>=20.18.1`. Use this server command:

```bash
npx -y @upstash/context7-mcp@latest --api-key YOUR_API_KEY
```

Remote fallback configuration uses URL `https://mcp.context7.com/mcp` and header `Authorization: Bearer YOUR_API_KEY`. Verify remote access:

```bash
curl https://mcp.context7.com/ping
```

See [Context7 client setup](https://context7.com/docs/resources/all-clients) and [troubleshooting](https://context7.com/docs/resources/troubleshooting).

#### Excel MCP

[Excel MCP Server](https://github.com/negokaz/excel-mcp-server#installing-via-npm) supports Linux `ia32`, `x64`, and `arm64`. It requires Node.js 20+; Excel, LibreOffice, Go, a compiler, and native libraries are not required.

Use this local server command:

```bash
npx --yes @negokaz/excel-mcp-server@0.12.0
```

For OpenCode local MCP configuration, use this command array:

```json
["npx", "--yes", "@negokaz/excel-mcp-server@0.12.0"]
```

Optional `EXCEL_MCP_PAGING_CELLS_LIMIT` defaults to `4000`. Spreadsheet paths must be absolute and allowed by file permissions.

#### Git

Git is a built-in tool, not an MCP server. Confirm Git CLI is available with `git --version`; do not install a Git MCP package.

### Update the plugin version

Update public plugin with native CMD on Windows or Bash on Linux:

```text
opencode plugin -g @ahumandev/autocode@latest
```

Restart OpenCode after update. It detects OS at startup and uses CMD for Windows agents or Bash for Linux agents.

### Uninstall

Remove `@ahumandev/autocode` from [global OpenCode config](https://opencode.ai/docs/config/) `plugin` array, save config, and restart OpenCode. Default config directory is `<home>/.config/opencode`.

### Troubleshooting

- Confirm `opencode --version` works; use `where opencode` in Windows CMD or `command -v opencode` in Linux Bash.
- Confirm plugin install uses `opencode plugin -g @ahumandev/autocode@latest`.
- Confirm config directory. Note that `OPENCODE_CONFIG_DIR` overrides default opencode config directory.
- Keep JSON or JSONC valid and preserve unrelated config.
- Restart OpenCode after config or plugin changes, then run `/install`.
- Linux sandbox execution needs Bubblewrap; Windows does not use it and does not register sandbox agents or tools.

## Core

- [Configuration](configuration.md) — config locations, keys, model tiers, and DB/SSH environment variables.
- [Usage](usage.md) — more details on how to use AutoCode.
- [Self Learned Skills](skill.md) — reusable guidance files that extend AutoCode behavior.
- [Terminology](terminology.md) — glossary of AutoCode concepts.

## Development & Distribution

- [Development](development.md) — architecture, local setup, commands, testing, and local plugin deployment.
- [Distribution Guide](distribution.md) — distributing AutoCode on public registries.
