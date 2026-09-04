# Installation

Use this guide as source of truth for OpenCode + AutoCode setup.

Goal: install AutoCode plugin for OpenCode.

## Important LLM Instructions

- Do not overwrite existing OpenCode config.
- Merge changes into existing config.
- Do not guess random `sudo` commands.
- If official OpenCode install docs give multiple options, ask user which one they want.
- If blocked by correctable obstacle (like wrong path, dependency missing/conflict, wrong env var): then correct obstacle and continue.
- If blocked because `sudo` privileges or secrets are required: then provide detailed instructions to user with exact cli commands user need to manually execute on his system.
- If blocked because of non-correctable obstacle (like no internet, incompatible environment, no disk space): then stop and report problem to user.

---

## Installation Steps

### Step 1: Detect host OS

1. Detect host OS before running commands.
2. Use native CMD commands on Windows and Bash commands on Linux.

### Choose Platform Route

Select route before running installation commands:

- **Native Windows:** Use CMD for all installation checks and commands. Continue with [Step 2](#step-2-check-if-opencode-already-exists), then configure Chrome in [Chrome DevTools MCP](#chrome-devtools-mcp).
- **Native Linux:** Use Bash for all installation checks and commands. Continue with [Step 2](#step-2-check-if-opencode-already-exists), then configure Chrome in [Chrome DevTools MCP](#chrome-devtools-mcp).
- **WSL:** Use Bash for all installation checks and commands. Continue with [Step 2](#step-2-check-if-opencode-already-exists). Use Linux Chrome in WSL when possible. Otherwise, use [Windows Chrome remote debugging](#wsl).

### Step 2: Check if OpenCode already exists

Run commands for host OS.

**With CMD (Windows)**

```cmd
opencode --version
where opencode
```

**With Bash (Linux)**

```bash
opencode --version
command -v opencode
```

If version prints, continue with Step 4.

### Step 3: Install OpenCode

1. Install OpenCode according to [OpenCode Installation Docs](https://opencode.ai).
2. Use official OpenCode install command or package-manager option for that OS.
3. Ask user before commands needing `sudo` or system changes.

After installation, rerun Step 2.

### Step 4: Check npm and Registry

Run commands for host OS.

**With CMD (Windows)**

```cmd
npm --version
npm ping
where npm
```

**With Bash (Linux)**

```bash
npm --version
npm ping
command -v npm
```

Continue only when command path and version print and npm registry access works. If npm or registry is unavailable, report blocked dependency or network access; do not guess a package-manager command.

### Step 5: Install AutoCode Plugin

Run this in native CMD or Bash:

```text
opencode plugin @ahumandev/autocode@latest -g -f
```

`-g` installs plugin in global OpenCode configuration. Default config directory is `<home>/.config/opencode`; `OPENCODE_CONFIG_DIR` overrides it, then `XDG_CONFIG_HOME/opencode` applies when `OPENCODE_CONFIG_DIR` is unset.

### Step 6: Start AutoCode Install

Run:

```text
opencode run "/autocode-install"
```

AutoCode detects OS. Agents use native CMD on Windows and Bash on Linux. `/autocode-install` checks and remediates Windows dependencies only. It does not install Bubblewrap; on Linux, install Bubblewrap separately if sandbox execution is needed.

Generated skills are stored in `<home>/.agents/skills`. Windows does not register sandbox agents or sandbox tools.

## Correctable Obstacles

### Fix opencode PATH problem

Use this if OpenCode install worked but shell cannot find `opencode`. Do not guess install directory.

**With CMD (Windows)**

```cmd
where opencode
echo %PATH%
set PATH=C:\path\from\opencode\install;%PATH%
opencode --version
```

**With Bash (Linux)**

```bash
command -v opencode || true
echo "$PATH"
export PATH="/path/from/opencode/install:$PATH"
opencode --version
```

Use real directory from official OpenCode install output. Persist PATH with OS shell or system settings after verifying it.

### Fix opencode config parse error

Use this if OpenCode says config is invalid.

Check parse error details, then check these things:

- `.json` file has no comments.
- `.json` file has no trailing commas.
- `.jsonc` file can keep comments and trailing commas.
- Quotes and brackets match.
- `plugin` is an array.

Bad:

```json
{
  "plugin": [
    "@ahumandev/autocode",
  ],
}
```

Good JSON:

```json
{
  "plugin": [
    "@ahumandev/autocode"
  ]
}
```

If current file uses comments or trailing commas, rename plan should be careful:

1. Keep file as `opencode.jsonc`, or
2. Remove comments and trailing commas before using `opencode.json`.

### Fix plugin install failure

Use this if OpenCode starts but cannot install AutoCode.

1. Run `opencode plugin @ahumandev/autocode@latest -g -f` again.
2. Confirm OpenCode global config is valid and preserves unrelated settings.
3. Restart OpenCode.
4. Run `/autocode-install` after startup.

Check configured directory first: default is `<home>/.config/opencode`; `OPENCODE_CONFIG_DIR` overrides it, then `XDG_CONFIG_HOME/opencode` when unset.

### Fix stale local shim

Use only for local repository development with a shim. Build and install scripts are cross-platform Bun scripts.

Remove stale current shim, then run shim install from AutoCode repository root.

**With CMD (Windows)**

```cmd
del /f /q "%USERPROFILE%\.config\opencode\plugins\autocode.js"
bun run install:shim
```

**With Bash (Linux)**

```bash
rm -f "$HOME/.config/opencode/plugins/autocode.js"
bun run install:shim
```

If config directory is overridden, replace default shim path with configured directory. `autocode.js` is current shim filename.

### Official OpenCode Docs

Still stuck? Read [Official OpenCode Docs](https://opencode.ai/docs).

## Success

Success checks:

- `opencode --version` prints version.
- `opencode plugin @ahumandev/autocode@latest -g -f` completes.
- OpenCode starts and `/autocode-install` runs.
- Generated skills, when created, are in `<home>/.agents/skills`.

Do not claim a native Windows runtime test.

## Chrome DevTools MCP

Set up Chrome DevTools MCP after AutoCode plugin install.

Prerequisites: Node.js LTS with npm and current stable Chrome. Global npm install is not required.

Merge this entry into existing global OpenCode config at `<home>/.config/opencode/opencode.json`; never overwrite unrelated settings. If `mcp` already exists, add `chrome-devtools` inside it. Config-directory overrides remain as documented in [Step 5](#step-5-install-autocode-plugin).

```json
{
  "mcp": { "chrome-devtools": { "type": "local", "command": ["npx", "-y", "chrome-devtools-mcp@latest"] } }
}
```

Read [Chrome DevTools MCP README](https://github.com/ChromeDevTools/chrome-devtools-mcp), [OpenCode configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/client-configurations.md#opencode), and [troubleshooting](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md).

Verify setup:

1. Run `npx -y chrome-devtools-mcp@latest --help`.
2. Restart OpenCode.
3. Prompt OpenCode: `Check the performance of https://developers.chrome.com`.

### WSL

Preferred: use Linux Chrome in WSL. Alternative: use Windows Chrome remote debugging with mirrored networking enabled:

```cmd
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\path\\to\\dir
```

Connect MCP to Windows Chrome:

```text
npx -y chrome-devtools-mcp@latest --browser-url http://127.0.0.1:9222
```

**Caution:** Remote-debugging browser profile data can expose local browsing data. Use separate `--user-data-dir`.

## Open Websearch MCP

Set up Open Websearch MCP after AutoCode plugin install.

Install package:

```bash
npm install -g open-websearch@latest
```

Merge this entry into existing global OpenCode config at `<home>/.config/opencode/opencode.json`; never overwrite unrelated settings. If `mcp` already exists, add `open-websearch` inside it. Config-directory overrides remain as documented in [Step 5](#step-5-install-autocode-plugin).

Default config:

```json
{
  "mcp": {
    "open-websearch": {
      "type": "local",
      "command": ["open-websearch"],
      "environment": { "MODE": "stdio" }
    }
  }
}
```

### Optional custom local proxy

Ask user for proxy URL before adding proxy settings. Do not guess that local proxy exists. `http://127.0.0.1:1234` applies only to current environment.

Merge proxy settings into `environment` only when user confirms custom local proxy URL:

```json
{
  "mcp": {
    "open-websearch": {
      "type": "local",
      "command": ["open-websearch"],
      "environment": {
        "MODE": "stdio",
        "USE_PROXY": "true",
        "PROXY_URL": "http://127.0.0.1:1234"
      }
    }
  }
}
```

Verify setup:

1. Run `open-websearch --help`.
2. Restart OpenCode.
3. Ask OpenCode to run a web search.

## Uninstall AutoCode

Remove `@ahumandev/autocode` from global OpenCode `plugin` array and restart OpenCode. Do not delete unrelated plugins or settings.

For repository-only shim workflow, use `del /f /q` in Windows CMD or `rm -f` in Linux Bash for `autocode.js`; see [Fix stale local shim](#fix-stale-local-shim).
