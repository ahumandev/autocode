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

### Step 1: Check if OpenCode already exists

Run this.

```bash
opencode --version
```

If you see a version, skip to Step 3.

### Step 2: Install OpenCode

Fetch official OpenCode install guidance here:

- https://opencode.ai
- https://opencode.ai/docs

Do this:

1. Find official install step for your OS.
2. Use only official command or official package manager option.
3. If docs offer package manager choices and user has a preference, use that one.
4. If docs need `sudo` or system package changes, ask user first.

After install, test again.

```bash
opencode --version
command -v opencode
```

Good output looks like this.

```text
<version>
/some/path/opencode
```

If version works but `opencode` still fails in a new shell, see Fix PATH problem.

### Step 3: Check npm and registry

Run this

```bash
npm --version
npm ping
```

Also check this.

```bash
command -v npm
```

Good result:

- `command -v npm` prints a real path.
- `npm --version` prints a version.
- npm registry access works.

If `npm` command is missing, stop and use the blocked npm report from If blocked.

If `npm ping` fails, stop and use the blocked internet/registry report from If blocked.

### Step 4: Check OpenCode config location

OpenCode reads global config from one of these files.

- `~/.config/opencode/opencode.json`
- `~/.config/opencode/opencode.jsonc`

Check what already exists.

```bash
ls -la "$HOME/.config/opencode" 2>/dev/null || true
test -f "$HOME/.config/opencode/opencode.json" && echo "have json"
test -f "$HOME/.config/opencode/opencode.jsonc" && echo "have jsonc"
```

If folder does not exist, make it.

```bash
mkdir -p "$HOME/.config/opencode"
```

### Step 5: Add AutoCode plugin

#### If no OpenCode config exists yet

Create `~/.config/opencode/opencode.jsonc` with this exact content.

```jsonc
{
  "plugin": [
    "@ahumandev/autocode"
  ]
}

```

#### If config already exists

Do not replace whole file.

Merge `@ahumandev/autocode` into existing `plugin` array.

Example merge:

```jsonc
{
  // keep old settings
  "theme": "dark",
  "plugin": [
    "some-other-plugin",
    "@ahumandev/autocode"
  ]
}
```

Rules:

- Keep old settings.
- Keep old plugins.
- Add AutoCode once.
- If file uses comments or trailing commas, keep `.jsonc`.
- If file is plain `.json`, keep strict JSON syntax.

### Step 6: Save config safely

Check file before start.

```bash
sed -n '1,200p' "$HOME/.config/opencode/opencode.jsonc" 2>/dev/null || true
sed -n '1,200p' "$HOME/.config/opencode/opencode.json" 2>/dev/null || true
```

Good result:

- File has valid JSON or JSONC.
- `plugin` array includes `@ahumandev/autocode`.
- File is not overwritten with unrelated settings removed.

### Step 7: Install AutoCode dependencies

Run:

```bash
opencode run --format json --command autocode-install
```

- If output contains `"message":"Command not found: \"autocode-install\"`, this means AutoCode plugin not registered, config failed.
- If output contains `"type":"step_start"`, this means OpenCode found AutoCode and install work started. Wait for optional AutoCode dependency installation to complete.

If AutoCode dependency installation fail, AutoCode will still work.

---

## Correctable Obstacles

### Fix opencode PATH problem

Use this if install worked but shell cannot find `opencode`.

Check path again.

```bash
command -v opencode || true
echo "$PATH"
```

If `opencode` binary exists but is not in `PATH`:

1. Find install location from official OpenCode install output.
2. Add that location to shell startup file.
3. Open a new shell.
4. Test again with `opencode --version`.

Common shell files:

- Bash: `~/.bashrc`
- Zsh: `~/.zshrc`

Example line format:

```bash
export PATH="/path/from/opencode/install:$PATH"
```

Do not guess path. Use real path from official install result.

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

Use this if OpenCode starts but cannot install `@ahumandev/autocode`.

Check these things:

- Package name is exact: `@ahumandev/autocode`.
- Config syntax is valid.
- OpenCode was restarted after config change.

---

## Success

- `opencode` starts without errors.
- AutoCode plugin in `opencode` registers commands like `autocode-install`.

---

## Uninstall AutoCode

Remove `@ahumandev/autocode` from `plugin` array.

Then restart OpenCode.

```bash
opencode
```

Do not delete unrelated plugins or settings.
