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
| `autocode.tier`                      | string           | Selects a named tier set from `autocode.tiers`.                                                                                    | No selected set.                                 |
| `autocode.tiers`                     | object           | Either a direct map of `cheap`, `fast`, `balanced`, and `smart` tier settings, or a map of named tier sets containing those tiers. | No overrides.                                    |
| `autocode.tiers.<tier>.model`        | string           | Optional model override for a tier.                                                                                                | Uses the agent or OpenCode default when omitted. |
| `autocode.tiers.<tier>.variant`      | string           | Optional variant override for a tier.                                                                                              | Uses the agent or OpenCode default when omitted. |
| `permission.external_directory`      | object or string | Path-pattern permissions for external-directory access. Values are `allow`, `ask`, or `deny`.                                      | `{}`                                             |
| `autocode.sandbox.sync_method`       | string           | Sandbox sync strategy. Valid values are `auto`, `overlayfs`, `reflink`, and `copy`.                                                | Unset.                                           |
| `autocode.sandbox.distro.cache_path` | string           | Optional sandbox distribution cache path.                                                                                          | Unset.                                           |
| `autocode.sandbox.distro.expire`     | string or number | Optional sandbox distribution expiry value.                                                                                        | Unset.                                           |

Recognised model tiers are `cheap`, `fast`, `balanced`, and `smart`. The `cheap` tier is also used as the `small_model` fallback for OpenCode title generation and compaction when OpenCode has no explicit `small_model`.

For example:

```jsonc
{
  "autocode": {
    "tier": "go",
    "tiers": {
      "go": {
        "smart":    { "model": "opencode-go/glm-5.2", "variant": "high" },
        "balanced": { "model": "opencode-go/minimax-m3", "variant": "medium" },
        "fast":     { "model": "opencode/deepseek-v4-flash-free", "variant": "low" },
        "cheap":    { "model": "opencode/deepseek-v4-flash-free", "variant": "low" }
      },
      "openai": {
        "smart":    { "model": "openai/gpt-5.5", "variant": "high" },
        "balanced": { "model": "openai/gpt-5.4", "variant": "medium" },
        "fast":     { "model": "openai/gpt-5.3-spark", "variant": "low" },
        "cheap":    { "model": "openai/gpt-5.4-mini", "variant": "low" }
      },
      "zai": {
        "smart":    { "model": "zai/glm-5.2", "variant": "high" },
        "balanced": { "model": "zai/glm-5.2", "variant": "medium" },
        "fast":     { "model": "zai/glm-5-turbo", "variant": "low" },
        "cheap":    { "model": "zai/glm-4.7", "variant": "low" }
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

OpenCode applies a last-matching-rule-wins model to external-directory permissions. Place broad defaults first and more specific overrides later.

See [OpenCode Go documentation](https://opencode.ai/docs/go#endpoints) for supported model names.

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

SSH tools: `autocode_ssh_command`, `autocode_ssh_list`, `autocode_ssh_read_attributes`, `autocode_ssh_write_attributes`, `autocode_ssh_read_file`, `autocode_ssh_write_file`, `autocode_ssh_edit_file`, `autocode_ssh_patch_file`, `autocode_ssh_glob`, `autocode_ssh_grep_file`.

Keyfile auth has precedence. A nonexistent or unreadable keyfile falls back to password. `AUTOCODE_SSH_{ssh_key}_AGENT` is used only when there is no readable `AUTOCODE_SSH_{ssh_key}_KEYFILE` and no `AUTOCODE_SSH_{ssh_key}_PASSWORD`. Idle SSH connections can be reused for 5 minutes. Remote glob/grep/patch/edit/write mirror local tool intent where practical, not exact parity.
