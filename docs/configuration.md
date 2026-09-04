# Configuration

AutoCode reads optional JSONC configuration from global OpenCode configuration first, then from project locations. Later candidates override earlier candidates, so local worktree or directory settings can replace global defaults without copying the whole file.

### Configuration locations

| Precedence | Location                                                                             | Behaviour                                                                 |
| ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1          | `~/.config/opencode/autocode.jsonc`                                                  | Global defaults are considered first.                                     |
| 2          | `.opencode/autocode.jsonc` in the OpenCode worktree                                  | Project or worktree settings override matching global values.             |
| 3          | `.opencode/autocode.jsonc` in the active directory, when different from the worktree | Directory-specific settings override matching worktree and global values. |

### Configuration keys

| Key                                   | Type             | Description                                                                                         | Default                                          |
| ------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `autocode.learned.max`                | integer          | Limits how many learned skills are kept per category before oldest are pruned.                      | `10`                                             |
| `autocode.skills.freeze`              | boolean          | Strictly skips first-run extraction and all generated-root mutation; stale generated skills remain. | `false`                                          |
| `autocode.sandbox.sync_method`        | string           | Sandbox sync strategy. Valid values are`auto`, `overlayfs`, `reflink`, and `copy`.                  | Unset.                                           |
| `autocode.sandbox.distro.cache_path`  | string           | Optional sandbox distribution cache path.                                                           | Unset.                                           |
| `autocode.sandbox.distro.expire`      | string or number | Optional sandbox distribution expiry value.                                                         | Unset.                                           |
| `autocode.tier`                       | string           | Selects a named tier set from`autocode.tiers`.                                                      | No selected set.                                 |
| `autocode.tiers.<set>.<tier>.model`   | string           | Optional model override for a tier in a tier set.                                                   | Uses the agent or OpenCode default when omitted. |
| `autocode.tiers.<set>.<tier>.variant` | string           | Optional variant override for a tier in a tier set.                                                 | Uses the agent or OpenCode default when omitted. |
| `permission.external_directory`       | object or string | Path-pattern permissions for external-directory access. Values are`allow`, `ask`, or `deny`.        | `{}`                                             |

OpenCode applies a last-matching-rule-wins model to external-directory permissions. Place broad defaults first and more specific overrides later.

See [OpenCode Go documentation](https://opencode.ai/docs/go#endpoints) for supported model names.

### Web session links

AutoCode resolves server URL in this order:

1. `AUTOCODE_WEB_URL`
2. Runtime server URL
3. Client base URL

`AUTOCODE_WEB_URL` independently sets origin used for browser links. When unset, browser links use resolved server origin. For example:

```sh
AUTOCODE_WEB_URL="https://app.example.com"
```

`AUTOCODE_WEB_URL` selects server URL. `AUTOCODE_WEB_URL` overrides only browser-link origin.

#### Skills

Set `autocode.skills.freeze` to `true` to strictly skip first-run extraction and every generated-root mutation. Existing stale generated skills remain until manually removed or a later unfrozen startup updates them.

`autocode.learned.max` caps how many learned skills AutoCode retains in each category. Each category is pruned independently:

- `corrections`
- `env`
- `permissions`
- `preferences`

Pruning is count-based, not time-based: there is no TTL or expiry window. It runs once per plugin startup, not on every skill write. Within each category AutoCode keeps the `max` newest skills and removes the rest. "Newest" is determined by the `SKILL.md` modification time; ties are broken by directory name in descending order. Pruned skills are removed entirely with `rm -rf`. Re-learning an existing skill refreshes its `SKILL.md` mtime, so it survives longer.

Only `Number.isInteger(max) && max > 0` overrides the default. Missing, zero, negative, or non-integer values fall back to `10`.

For example:

```jsonc
{
  "autocode": {
    "skills": {
      "freeze": false,
      "learned": {
        "max": 25
      }
    }
  }
}
```

#### Tiers

Tier assignment requirements:

| Tier       | Intelligence | Reasoning | Context | Usage                                                        |
| ---------- | ------------ | --------- | ------- | ------------------------------------------------------------ |
| `smart`    | Frontier     | high       | large   | Autonomous planning, orchestration and troubleshooting       |
| `balanced` | Strong       | medium    | large   | Interact with users and agents (capable, faster, affordable) |
| `operator` | Strong       | low       | large   | Complex high risk tool calls (operate systems)               |
| `context`  | Basic        | low       | large   | Gather and summarize large volumes of data                   |
| `fast`     | Fast         | none      | small   | Frequent low risk tool calls                                 |
| `cheap`    | Cheap        | none      | small   | Formatting text (session titles)                             |
| `spy`      | Configured   | Configured | Configured | Primary, visible, read-only safety review and guidance       |

`spy` agent is available only when selected tier set explicitly configures a `spy` tier. No default spy model exists, and `balanced` does not enable `spy`. `auto` agents requires an explicitly configured `smart` tier.

`spy` gives read-only safety review and guidance. Use it directly: it is visible as a primary agent and cannot receive session handoff.

#### Complete Configuration Example

```jsonc
{
  "autocode": {
    "skills": {
      "freeze": false,
      "learned": {
        "max": 25
      },
    },
    "tier": "openai",
    "tiers": {
      "openai": {
        "smart":    { "model": "openai/gpt-5.6-sol", "variant": "high" },
        "balanced": { "model": "openai/gpt-5.6-terra", "variant": "medium" },
        "operator": { "model": "openai/gpt-5.6-terra", "variant": "low" },
        "context":  { "model": "openai/gpt-5.6-luna", "variant": "low" },
        "fast":     { "model": "openai/gpt-5.3-codex-spark", "variant": "low" },
        "cheap":    { "model": "openai/gpt-5.6-luna", "variant": "none" },
        "spy":      { "model": "ollama/llama-3.1-8B", "variant": "none" }
      },
      "zai-coding-plan": {
        "smart":    { "model": "zai-coding-plan/glm-5.2", "variant": "high" },
        "balanced": { "model": "zai-coding-plan/glm-5.2", "variant": "high" },
        "operator": { "model": "zai-coding-plan/glm-5.2", "variant": "high" },
        "context":  { "model": "zai-coding-plan/glm-4.7", "variant": "low" },
        "fast":     { "model": "zai-coding-plan/glm-4.5-air", "variant": "low" },
        "cheap":    { "model": "zai-coding-plan/glm-4.5-air", "variant": "low" }
      }
    }
  },
  "permission": {
    "external_directory": {
      "/tmp/safe/**": "allow",
      "/tmp/safe/specific": "deny"
    }
  }
}
```

### Database environment variables

| Variable pattern                  | Description                                                                                                           | Default |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------- |
| `AUTOCODE_DB_{db_key}_CONNECTION` | Required connection string for one configured database target. Supported formats determine the adapter automatically. | None.   |
| `AUTOCODE_DB_{db_key}_USERNAME`   | Optional username supplied alongside the connection when needed.                                                      | Unset.  |
| `AUTOCODE_DB_{db_key}_PASSWORD`   | Optional password supplied alongside the connection when needed.                                                      | Unset.  |

Replace `{db_key}` with letters, digits, or underscores. Environment lookup is case-insensitive. Then instruct agent to use your chosen `{db_key}` to access your DB.

### REST authentication

For REST tools that use `rest_key`, authentication is resolved in this order:

1. An explicit request `Authorization` header is used when provided.
2. Otherwise, AutoCode uses `AUTOCODE_REST_<KEY>_AUTHORIZATION`.
3. Otherwise, it builds HTTP Basic authentication from both `AUTOCODE_REST_<KEY>_USERNAME` and `AUTOCODE_REST_<KEY>_PASSWORD`.

Replace `<KEY>` with the `rest_key` in uppercase. For example, for `rest_key: billing`:

```sh
AUTOCODE_REST_BILLING_AUTHORIZATION="Bearer <token>"
```

Use either the raw `Authorization` variable or the username/password pair; do not place real credentials in project files.

### SSH tool suite

Configure each SSH target with `{ssh_key}` environment variables:

| Variable pattern                  | Description                                         | Default |
| --------------------------------- | --------------------------------------------------- | ------- |
| `AUTOCODE_SSH_{ssh_key}_HOST`     | Required SSH hostname or IP address for one target. | None.   |
| `AUTOCODE_SSH_{ssh_key}_PORT`     | Optional SSH port. Valid range is `1` to `65535`.   | `22`.   |
| `AUTOCODE_SSH_{ssh_key}_KEYFILE`  | Optional private key file path.                     | Unset.  |
| `AUTOCODE_SSH_{ssh_key}_KEYPASS`  | Optional private key passphrase.                    | Unset.  |
| `AUTOCODE_SSH_{ssh_key}_USERNAME` | Optional SSH username.                              | `root`. |
| `AUTOCODE_SSH_{ssh_key}_PASSWORD` | Optional SSH password.                              | Unset.  |
| `AUTOCODE_SSH_{ssh_key}_AGENT`    | Optional SSH agent socket or path.                  | Unset.  |

`AUTOCODE_SSH_{ssh_key}_HOST` must contain only a hostname or IP address. AutoCode does not parse `host:port` values from `HOST`; set `AUTOCODE_SSH_{ssh_key}_PORT` when a target uses a non-default port.

Keyfile auth has precedence. A nonexistent or unreadable keyfile falls back to password. `AUTOCODE_SSH_{ssh_key}_AGENT` is used only when there is no readable `AUTOCODE_SSH_{ssh_key}_KEYFILE` and no `AUTOCODE_SSH_{ssh_key}_PASSWORD`. Idle SSH connections can be reused for 5 minutes. Remote glob/grep/patch/edit/write mirror local tool intent where practical, not exact parity.
