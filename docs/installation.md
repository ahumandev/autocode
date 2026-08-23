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

If version prints, continue with Step 3.

### Step 2: Install OpenCode

1. Install OpenCode according to [OpenCode Installation Docs](https://opencode.ai).
2. Use official OpenCode install command or package-manager option for that OS.
3. Ask user before commands needing `sudo` or system changes.

After installation, rerun Step 2.

### Step 3: Check npm and registry

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

### Step 4: Install AutoCode plugin

Run this in native CMD or Bash:

```text
opencode plugin @ahumandev/autocode@latest -g -f
```

`-g` installs plugin in global OpenCode configuration. Default config directory is `<home>/.config/opencode`; `OPENCODE_CONFIG_DIR` overrides it, then `XDG_CONFIG_HOME/opencode` applies when `OPENCODE_CONFIG_DIR` is unset.

### Step 5: Start `/autocode-install`

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

Use the blocked config parse error report from If blocked.

Check these things:

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

**With Bash (Linux)**

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

## Uninstall AutoCode

Remove `@ahumandev/autocode` from global OpenCode `plugin` array and restart OpenCode. Do not delete unrelated plugins or settings.

For repository-only shim workflow, use `del /f /q` in Windows CMD or `rm -f` in Linux Bash for `autocode.js`; see [Fix stale local shim](#fix-stale-local-shim).
