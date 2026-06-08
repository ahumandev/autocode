---
name: design-tech
description: Use this skill before implementing any feature to understand the project's technical design and standards.
---

# Technical Design

## Architectural Overview
Autocode is a solution-plan-first OpenCode plugin that injects bundled agents, commands, tools, and generated skills into the host configuration. Canonical flow is `research -> design`, then `design -> auto` or `design -> assist`. Canonical commands are `/job-concepts`, `/job-design`, `/job-draft`, `/job-execute-assist`, `/job-execute-auto`, `/job-review`, and `/job-terminate`. Canonical lifecycle statuses/directories are `concepts`, `drafts`, `assist`, `executing`, `facilitate`, `review`, and `terminated`.

## Technology Choices
- **TypeScript OpenCode plugin** (`src/plugin.ts`): Merges defaults, injects generated skills, and maps model tiers.
- **JSONC config** (`src/config.ts`): Loads global, worktree, then directory config with later overrides.
- **OpenCode SDK sessions**: `auto` uses `session.create` and `session.promptAsync` for job sessions.
- **Bun toolchain**: Build, test, typecheck, and read-only database access.
- **Markdown plans** (`src/tools/autocode_plan_save.ts`): Canonical sections are Problem, Requirements, Constraints, Risks, Proposed Solution.
- **Criteria YAML** (`src/tools/autocode_criteria.ts`): Flat top-level `C*` checklist for active planned jobs.
- **Solution audit** (`.agents/jobs/{status}/{job_name}/solution.md`): Guarded append-only ledger for status changes and accepted criteria.
- **Database env config** (`src/utils/db.ts`): Credentials come from `AUTOCODE_DB_<KEY>_{CONNECTION,USERNAME,PASSWORD}`.

## Key Data Models
- **Job lifecycle** (`src/utils/jobs.ts`): Canonical lifecycle state is derived from `.agents/jobs/concepts/{label}.md`, `.agents/jobs/drafts/{job_name}/`, `.agents/jobs/assist/{job_name}/`, `.agents/jobs/executing/{job_name}/`, `.agents/jobs/facilitate/{job_name}/`, `.agents/jobs/review/{job_name}/`, and `.agents/jobs/terminated/{job_name}/`.
- **Plan markdown** (`src/tools/autocode_plan_save.ts`): Executable plans persist under `.agents/jobs/drafts/{job_name}/plan.md` and can be revised in place before or during lifecycle work.
- **Session file** (`.agents/jobs/executing/{job_name}/session.yml`): Stores the primary session id for planned auto jobs.
- **Criteria track** (`src/tools/autocode_criteria.ts`): `criteria.yml` tracks active `C*` metrics; accepted criteria append evidence to `solution.md`.
- **Autocode config** (`src/config.ts`): Tier config supports `cheap`, `fast`, `balanced`, and `smart` with legacy compatibility.

## Key API Endpoints
- `/job-concepts`: Create concept Markdown for discovered problems or ideas.
- `/job-design`: Load optional concept or Research Report context and continue solution planning.
- `/job-draft`: Save the executable solution plan and its selected context.
- `autocode_plan_save`: Create or update executable plan sections.
- `autocode_job_list`: Return active jobs by scanning lifecycle directories.
- `autocode_job_status`: Move one planned job directory between logical lifecycle statuses and append a status entry to `solution.md`.
- `/job-execute-auto`: Start or resume autonomous execution for an active planned job.
- `/job-execute-assist`: Start interactive assistive execution for an active planned job.
- `/job-review`: Terminate any eligible job after criteria and commit checks, including accepting reviewed work into `.agents/jobs/terminated/{job_name}/`.
- `/job-terminate`: Close a job intentionally without acceptance.
- `autocode_criteria_list`: List unmet planned-job criteria.
- `autocode_criteria_set`: Set or complete a criterion.
- `autocode_criteria_remove`: Remove one active criterion.
- `autocode_db_schemas`: List database schemas.
- `autocode_db_tables`: List tables in a schema.
- `autocode_db_table`: Read table metadata.
- `autocode_db_table_read`: Run bounded read-only table queries.
- `task_external`: Spawn a new OpenCode session in another project directory.

## Error Handling
- **Shared response builders** (`src/utils/tools.ts`): Retry and abort responses are standardized JSON strings.
- **Lifecycle feedback persistence** (`src/utils/jobs.ts`): Lifecycle mutations require user-facing feedback before the tool call; `autocode_job_status` appends a guarded `solution.md` entry with `YY-MM-DD hh:mm:ss` timestamps and `Update Status To {status}` titles. Accepted criteria append guarded `solution.md` entries titled `Accepted Criteria {criteria}`.
- **Criteria validation** (`src/tools/autocode_criteria.ts`): Action/proof must be factual, short, and header-free.
- **Missing-file handling**: Some lifecycle tools treat `ENOENT` as retryable.
- **Retry limits**: Repeated failures eventually escalate to abort responses.

## Security Design
No application auth layer exists. Security is delegated to OpenCode permissions and agent-specific allowlists in `src/agents/index.ts`. External directory permissions are centralized by mapping `external_directory` and `task_external` through configured `permission.external_directory`, with fallback ask/deny behavior based on the agent. Read-only DB tools validate identifiers, parameterize queries, and never echo raw secrets.

Planned-job flow is explicit: `/job-design` continues solution planning, `/job-draft` persists the executable plan, `/job-execute-assist` and `/job-execute-auto` operate only on active planned jobs, `/job-review` can terminate eligible jobs after checks, and `/job-terminate` is reserved for intentional non-acceptance closure.

## External Integrations
- **OpenCode Plugin API** (`src/plugin.ts`): `config` merges agents, commands, and generated skills; `tool` registers runtime tools.
- **Generated skills** (`src/skills/index.ts`): Bundled skill markdown is emitted to the generated skills path and injected first.
- **OpenCode SDK v2**: `session.create` and `session.promptAsync` manage job sessions.
- **Autocode config** (`src/config.ts`): Optional JSONC config comes from global, worktree, then directory scope.
- **Bun SQL + drivers** (`src/utils/db.ts`): Database introspection supports PostgreSQL, MySQL, MariaDB, and SQLite.
- **External tasking** (`src/tools/task_external.ts`): Spawns `opencode run --agent general` in another project directory.

## Known Risks & Anti-Patterns
- **Legacy config shape**: `autocode.model` is still accepted.
- **Heading-based plan parsing**: Malformed markdown lowers plan fidelity.
- **Whole-file criteria rewrites**: `criteria.yml` has no own concurrency guard.
- **Planned-job dependency**: Criteria tools only work for active planned jobs.
- **Task external isolation**: Spawned sessions start with no current-project context.
- **DB tool scope**: Database tools are intentionally read-only and single-purpose.

---

**IMPORTANT**: Update `.agents/skills/design/tech/SKILL.md` whenever architecture, APIs, data models, security, or integrations change.

## Lifecycle sandbox tools

Lifecycle sandbox tools provision per-job sandboxes under `.agents/sandboxes/{job_name}/{sandbox_name}` for isolated research, design, or execution support. Linux sandbox execution requires usable bubblewrap (`bwrap`); Autocode does not use `proot` or `proot-distro` fallbacks. Unsupported hosts are macOS, Windows, Android/Termux, non-Linux hosts, and Linux hosts without usable `bwrap` or user namespace support. After user config overrides are merged, unsupported hosts disable `execute_sandbox` and force-deny `autocode_sandbox_create`, `autocode_sandbox_cli`, and `autocode_sandbox_delete`, including wildcard permission overrides. Diagnose missing or unusable `bwrap` by installing/exposing bubblewrap and ensuring user namespaces work; legacy `proot` or `proot-distro` sandbox metadata cannot run and should be recreated or migrated. Treat bubblewrap as the isolation mechanism, with actual policy determined by explicit mounts/namespaces and security dependent on host kernel and user namespace support.
