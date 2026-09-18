# Skills and local memory

`learn` stores a durable local memory. `skill_edit` creates or updates a reusable skill. Local memories are not reusable `SKILL.md` documents.

## Storage locations

- Active local-memory store: `.opencode/autocode/memories/`. A fresh transition starts empty; runtime creates Markdown `.md` memory files only through `learn`.
- Reusable skills: each skill directory contains `SKILL.md` and may contain supporting files.
- Managed built-in skills: `$XDG_CONFIG_HOME/skills/autocode` when `XDG_CONFIG_HOME` is set; otherwise `~/.agents/skills/autocode`.
- Managed GitHub skills: `$XDG_CONFIG_HOME/skills/autocode/github/<owner>/<project>/<skill>/` when `XDG_CONFIG_HOME` is set; otherwise `~/.agents/skills/autocode/github/<owner>/<project>/<skill>/`.
- Recommended global manual skill path: `~/.config/opencode/skills/<skill-name>/`.
- Do not put custom skills in managed `autocode` directories; AutoCode reconciles them.
- GitHub is the only supported provider. Its primary cache is `~/.cache/autocode/github/<owner>/<project>/`; the fallback is `.opencode/autocode/cache/github/<owner>/<project>/` only after primary access returns `EACCES` or `EPERM`. Both cache trees are disposable. `bun run skill:sync` refreshes tracked snapshots; `bun run skill:sync -- --force-refresh` bypasses cached repositories.

Automatic local-memory recall considers only an eligible user message: `output.message.role` is exactly `user`, it has at least one text part, and authoritative runtime agent tier is `smart`. Only the first eligible user-role text message for each `[sessionID, agentName]` triggers automatic recall.

Automatic recall records one claim per `[sessionID, agentName]`. First eligible event claims it even when recall has no match or fails. Config refresh preserves claims; `session.deleted` clears that session; dispose clears all claims.

### Manual memory tools

- `autocode_memory_recall` schema: `{ keywords: string }`.
- `autocode_memory_forget` schema: `{ id_keyword: string }`.
- Manual `recall` and `forget` are available only to `advise`, `assist`, `auto`, `design`, `spy`, and `auto-troubleshoot`. `spy` `learn` remains denied after overrides.

### Manual recall

- `keywords` is comma-validated, then each keyword uses NFKC, case, and whitespace normalization with ordered deduplication.
- Recall scans each normalized keyword in declared order. Each keyword gets a full deterministic scan before the next; normalized whole phrases or identifier boundaries match primary ID, aliases, or context keywords on newest active version of each memory. A no-match keyword advances.
- Selected primary IDs persist across scans, output order is deterministic, and each primary ID emits once. Manual recall does not exclude memories already loaded as context.
- Only trusted complete XML memory blocks are returned. One cumulative model-visible UTF-16 budget of 7,000 characters carries across scans: whole blocks only; first overflow or exact-full accepted block stops entire lookup, with no bin-packing or later keyword scans.
- Automatic recall output remains limited to 4,000 characters.

### Manual forget and concurrent saves

- `id_keyword` is normalized, then matches exact primary ID only; aliases and context keywords never match.
- Forget deletes every timestamped active version for matching primary ID. Zero matches are idempotent success.
- Before any removal, forget validates every active `.md` filename. A malformed filename aborts before deletes.
- Forget removes at most 8 files concurrently. Filesystem errors use abort/retry behavior: successful partial deletes remain deleted, and retrying same exact ID safely removes remaining versions.
- Results report IDs, counts, and locations, never memory bodies.
- Pre-scan is a snapshot. A concurrent `learn` or save can create a new version after scan that survives this attempt; removal is best effort during concurrent saves, and retrying exact ID is safe.

## `learn` durable memory

Use `learn` for concise, durable facts: preferences, corrected fixes, environment configuration, project conventions, safety constraints, and verified findings. Do not store secrets, credentials, tokens, private keys, or temporary task progress. Learning, recall, and forget do not require trusted-attestation metadata.

`learn` saves a local memory with a primary ID keyword, optional alias/context keywords, examples, and references. Its result reports saved filename, location, storage root, normalized ID, duplicate-keyword removal, same-time replacements, and recall status.

There is no legacy import, conversion, or seed step. The archive is outside active-memory scans.

## Reusable `SKILL.md` format

Each reusable `SKILL.md` starts with YAML frontmatter, followed by a Caveman English body.

```yaml
---
name: <skill-name>
description: Use this skill when [TRIGGER] to [BENEFIT]. NEVER for [EXCLUSIONS].
---
```

- `name`: stable reusable skill name.
- `description`: caller-written trigger / benefit / exclusion guidance in Caveman English, maximum 40 words.
- Body: reusable instructions in Caveman English.
- Put detailed templates and companion material in references. Link every reference from the body using its exact relative path.

## Reusable skill creation and updates

Use `skill_edit` to create or update reusable skills and their `references[]`. Keep reusable instructions, templates, and references in the skill directory; do not use `learn` as a skill-authoring path.

## Skill discovery and loading

The agent system prompt instructs: check skill list before work; load a matching skill through `skill`.

Skill roots are walked in priority order:

1. Generated plugin-bundled skills.
2. Plugin skills parent.
3. Agent skills under `.agents/skills/`.
4. Project skills under `.opencode/skills/`.

- Match logic is exact name match: `candidate.name === name`.
- Dedup cache: 30-minute TTL, 256 maximum entries per session, keyed by session ID + identity + hash.
- Legacy `.agents/skills/learned-*` categories are not registered or discovered. Ordinary reusable skills remain discoverable.
- `.opencode/autocode/memory-archive/v1/` is outside skill discovery and active-memory scans.

## Recovering an archived skill artifact

Archived files retain their original path below `v1/`. To recover or inspect one old skill artifact, copy the selected `SKILL.md` to that original relative path only. A restored legacy `.agents/skills/learned-*` path remains excluded from skill discovery and is not an active memory.

## See also

- [Configuration reference](configuration.md).
- [Usage guide](usage.md).
