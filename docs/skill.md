# Learned skills

Learned skills are persistent notes AutoCode writes to disk through `skill_learn_*` tools so future sessions recall corrections, environment quirks, permissions, and preferences without re-asking the user.

## Storage location

- Root: `{agentsStorageRoot}/.agents/skills/`.
- Each skill directory contains `SKILL.md` and may contain supporting files.
- Categories are metadata, never filesystem path segments.
- `agentsStorageRoot` is resolved by `resolveAgentsStorageRoot` with priority: worktree → directory → fallback.

Managed generated skills use `$XDG_CONFIG_HOME/skills/autocode` when `XDG_CONFIG_HOME` is set; otherwise `~/.agents/skills/autocode`.

- Managed built-in path, relative to home: `.agents/skills/autocode/<skill-name>/`.
- Managed GitHub path, relative to home: `.agents/skills/autocode/github/<owner>/<project>/<skill>/`.
- With `XDG_CONFIG_HOME` set, replace the managed root with `$XDG_CONFIG_HOME/skills/autocode`.
- Recommended global manual user-skill path, relative to home: `.config/opencode/skills/<skill-name>/`.
- Do not put custom skills in managed `.agents/skills/autocode/`; AutoCode reconciles that directory.
- GitHub is the only supported provider now. GitHub sync primary cache: `~/.cache/autocode/github/<owner>/<project>/`; fallback is `.opencode/autocode/cache/github/<owner>/<project>/` only after primary filesystem access returns `EACCES` or `EPERM`. The provider namespace leaves room for future sibling paths such as `~/.cache/autocode/gitlab/`; this does not indicate GitLab support. Both cache trees are disposable and safe to delete. `bun run skill:sync` refreshes tracked GitHub snapshots, and `bun run skill:sync -- --force-refresh` bypasses cached repositories and refreshes them remotely.

## SKILL.md format

Each `SKILL.md` starts with YAML frontmatter, followed by a Caveman English body.

Frontmatter:

```yaml
---
name: learned-{category}-{slug}
description: Use this skill when [TRIGGER] to [BENEFIT]. NEVER for [EXCLUSIONS].
---
```

- `name`: derived from the skill name parameter.
- `description`: written by the caller; should follow the trigger / benefit / exclusion pattern, in Caveman English, max 40 words.
- Body: skill content in Caveman English.

Example `SKILL.md` from [src/tools/skill_learn.test.ts:258-271](src/tools/skill_learn.test.ts):

```markdown
---
name: learned-corrections-avoid-re-render
description: Use this skill when a component re-renders unnecessarily.
---

- Wrap component in useMemo.

---

Content outdated? Call `skill_learn` with name=`learned-corrections-avoid-re-render` to correct.
```

## Categories

### Learned categories

| Category    | Tool                      | Trigger                                                              | Content                                                                                                 |
| ----------- | ------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| corrections | `skill_learn_correction`  | A mistake was self-corrected.                                        | Corrected mistakes and correction steps.                                                                |
| env         | `skill_learn_env`         | An unusual environment capability or limit was found.                | Environment quirks: OS, platform, hardware, scripts, network, or access limits.                         |
| permissions | `skill_learn_permission`  | User says a task is safe OR warns a task is unsafe.                  | Safety and manual-operation rules.                                                                      |
| preferences | `skill_learn_preferences` | User sets a permanent rule ("always", "never", ALL CAPS plus `!!!`). | Durable user conventions for programming, organization, naming, or editing.                             |

## Skill discovery and loading

The agent system prompt instructs: check the skill list BEFORE doing anything; load a skill through the `skill` tool if its description matches the task.

The skill list is walked from multiple roots in priority order:

1. Generated skills (plugin-bundled).
2. Plugin skills parent.
3. Learned skills: `.agents/skills/`.
4. Project skills: `.opencode/skills/`.

- Match logic: **exact name match** (`candidate.name === name`) — no keyword or embedding search.
- Dedup cache: 30 minute TTL, 256 max entries per session, keyed by sessionID + identity + hash.

## Pruning

- Count-based, NOT time-based — no TTL or expiry window.
- Runs once per plugin startup, NOT on each `skill_learn_*` call.
- Limit applies **per category**, not globally.
- Default: 10 per category; configurable via `autocode.learned.max` in `autocode.jsonc`.
- Keeps the N newest skills by `SKILL.md` mtime; ties broken by directory name descending.
- Pruned skill directories are removed with `rm -rf`.
- Re-learning an existing skill updates its `SKILL.md` mtime, so it survives longer.
- Invalid, zero, negative, or non-integer `max` falls back to 10.

See [Configuration: Learned skills](configuration.md#learned-skills) for the full config reference.

## See also

- [Configuration reference](configuration.md) — `autocode.learned.max` and other keys.
- [Usage guide](usage.md).
