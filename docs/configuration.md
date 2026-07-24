# Configuration

AutoCode reads optional JSONC configuration from global OpenCode configuration first, then from project locations. Later candidates override earlier candidates, so local worktree or directory settings can replace global defaults without copying the whole file.

### Configuration locations

| Precedence | Location                                                                             | Behaviour                                                                 |
| ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1          | `~/.config/opencode/autocode.jsonc`                                                  | Global defaults are considered first.                                     |
| 2          | `.opencode/autocode.jsonc` in the OpenCode worktree                                  | Project or worktree settings override matching global values.             |
| 3          | `.opencode/autocode.jsonc` in the active directory, when different from the worktree | Directory-specific settings override matching worktree and global values. |

### Configuration keys

| Key                                  | Type             | Description                                                                                                                        | Default                                          |
| ------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `autocode.learned.max`               | integer          | Limits how many learned skills are kept per category before oldest are pruned.                                                     | `10`                                             |
| `autocode.skills.freeze`              | boolean          | Strictly skips first-run extraction and all generated-root mutation; stale generated skills remain.                              | `false`                                          |
| `autocode.sandbox.sync_method`       | string           | Sandbox sync strategy. Valid values are `auto`, `overlayfs`, `reflink`, and `copy`.                                                | Unset.                                           |
| `autocode.sandbox.distro.cache_path` | string           | Optional sandbox distribution cache path.                                                                                          | Unset.                                           |
| `autocode.sandbox.distro.expire`     | string or number | Optional sandbox distribution expiry value.                                                                                        | Unset.                                           |
| `autocode.tier`                      | string           | Selects a named tier set from `autocode.tiers`.                                                                                    | No selected set.                                 |
| `autocode.tiers`                     | object           | Either a direct map of `cheap`, `fast`, `operator`, `balanced`, and `smart` tier settings, or a map of named tier sets containing those tiers. | No overrides.                                    |
| `autocode.tiers.<tier>.model`        | string           | Optional model override for a tier.                                                                                                | Uses the agent or OpenCode default when omitted. |
| `autocode.tiers.<tier>.variant`      | string           | Optional variant override for a tier.                                                                                              | Uses the agent or OpenCode default when omitted. |
| `permission.external_directory`      | object or string | Path-pattern permissions for external-directory access. Values are `allow`, `ask`, or `deny`.                                      | `{}`                                             |

Recognised model tiers are `cheap`, `fast`, `operator`, `balanced`, and `smart`. The `operator` tier sits between `balanced` and `fast` and requires explicit user configuration (no default). The `cheap` tier is also used as the `small_model` fallback for OpenCode title generation and compaction when OpenCode has no explicit `small_model`.

Legacy external skill arrays are ignored.

#### Generated skills

Set `autocode.skills.freeze` to `true` to strictly skip first-run extraction and every generated-root mutation. Existing stale generated skills remain until manually removed or a later unfrozen startup updates them.

For example:

```jsonc
{
  "autocode": {
    "tier": "go",
    "tiers": {
      "go": {
        "smart":    { "model": "opencode-go/glm-5.2", "variant": "high" },
        "balanced": { "model": "opencode-go/minimax-m3", "variant": "high" },
        "operator": { "model": "opencode-go/minimax-m3", "variant": "low" },
        "fast":     { "model": "opencode-go/deepseek-v4-flash", "variant": "low" },
        "cheap":    { "model": "opencode/deepseek-v4-flash-free", "variant": "low" }
      },
      "openai": {
        "smart":    { "model": "openai/gpt-5.6-sol", "variant": "high" },
        "balanced": { "model": "openai/gpt-5.6-terra", "variant": "medium" },
        "operator": { "model": "openai/gpt-5.6-terra", "variant": "low" },
        "fast":     { "model": "openai/gpt-5.3-codex-spark", "variant": "low" },
        "cheap":    { "model": "openai/gpt-5.3-codex-spark", "variant": "low" }
      },
      "zai": {
        "smart":    { "model": "zai/glm-5.2", "variant": "high" },
        "balanced": { "model": "zai/glm-5.2", "variant": "medium" },
        "operator": { "model": "zai/glm-5.2", "variant": "low" },
        "fast":     { "model": "zai/glm-4.7", "variant": "low" },
        "cheap":    { "model": "zai/glm-4.7-flash", "variant": "low" }
      },
      "zai-coding-plan": {
        "smart":    { "model": "zai-coding-plan/glm-5.2", "variant": "high" },
        "balanced": { "model": "zai-coding-plan/glm-5.2", "variant": "high" },
        "operator": { "model": "zai-coding-plan/glm-5.2", "variant": "high" },
        "fast":     { "model": "zai-coding-plan/glm-4.7", "variant": "low" },
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

Existing configurations that relied on `autocode.tiers.balanced` may need review because some agents now use the `operator` tier. Add an `autocode.tiers.operator` entry to your tier set for best results.

OpenCode applies a last-matching-rule-wins model to external-directory permissions. Place broad defaults first and more specific overrides later.

See [OpenCode Go documentation](https://opencode.ai/docs/go#endpoints) for supported model names.

#### Learned skills

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
    "learned": {
      "max": 25
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
