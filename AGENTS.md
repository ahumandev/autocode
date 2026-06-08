# Project Purpose
OpenCode plugin for research, solution design, lifecycle-tracked execution, database inspection, and documentation.


# Primary Features

- **Plugin injection**: Registers agents, commands, skills, tools @ `src/plugin.ts`
- **Primary agents**: Provides `research`, `design`, `auto`, and `assist` @ `src/agents/index.ts`
- **Workflow commands**: Exposes concept, design, draft, execution, review, and termination flows @ `src/commands/index.ts`
- **Generated skills**: Bundles Markdown skill sources @ `src/skills/`
- **Job lifecycle tools**: Manages listing, status, execution, acceptance, and termination @ `src/tools/`
- **Plan tools**: Reads and writes canonical plan sections @ `src/tools/autocode_plan_section.ts`
- **Criteria tracking**: Stores measurable execution criteria @ `src/tools/autocode_criteria.ts`
- **Read-only database tools**: Discovers tables and reads one table @ `src/tools/`
- **Cross-project tasking**: Runs isolated OpenCode sessions elsewhere @ `src/tools/task_external.ts`

# Architecture

- **Plugin entry**: TypeScript OpenCode plugin @ `src/plugin.ts`
- **Agent registry**: TypeScript agent catalogue @ `src/agents/index.ts`
- **Agent prompts**: TypeScript prompt templates @ `src/agents/prompts/`
- **Command registry**: TypeScript command definitions @ `src/commands/index.ts`
- **Skill registry**: Markdown skill source files @ `src/skills/<skill-name>/SKILL.md`
- **Runtime tools**: TypeScript OpenCode tools @ `src/tools/`
- **Shared utilities**: TypeScript helpers and tool wrappers @ `src/utils/`
- **Config**: OpenCode tier and plugin config @ `src/config.ts`

# File Structure

- `.agents/jobs/concepts/{label}.md`: Improvement concept
- `.agents/jobs/{job_status}/{job_name}/plan.md`: Solution plan
- `.agents/jobs/{job_status}/{job_name}/session.yml`: Primary auto session ID
- `.agents/jobs/{job_status}/{job_name}/criteria.yml`: Acceptance Criteria checklist
- `.agents/jobs/{job_status}/{job_name}/solution.md`: Guarded lifecycle audit log
- `.opencode/autocode.jsonc`: Local autocode config override
- `.opencode/plugin/autocode.ts`: Local plugin shim

# Rules

- Treat this repo as an OpenCode plugin/library, not a standalone app.
- Use Bun commands: `bun run build`, `bun run watch`, `bun test`, `bun run typecheck`.
- `research` gathers evidence and produces Research Reports.
- `design` creates solution plans from conversation.
- `auto` autonomously executes drafted jobs from solution plans.
- `assist` interactively executes immediate tasks with human control, optionally using solution plans as guidance.
- Slash commands are compatibility/convenience wrappers, not required lifecycle gates.
- Normal prompts can start or resume jobs and provide review or completion decisions.
- `plan.md` is canonical for executable jobs
- Planned-job lifecycle state is derived from canonical directories.
- Canonical lifecycle statuses/directories are `concepts`, `drafts`, `assist`, `executing`, `facilitate`, `review`, and `terminated` under `.agents/jobs/`.
- Canonical lifecycle locations are `.agents/jobs/concepts/{label}.md`, `.agents/jobs/drafts/{job_name}/`, `.agents/jobs/assist/{job_name}/`, `.agents/jobs/executing/{job_name}/`, `.agents/jobs/facilitate/{job_name}/`, `.agents/jobs/review/{job_name}/`, and `.agents/jobs/terminated/{job_name}/`.
- Concepts are optional and may be created manually or with `/job-concepts`.
- Typical flow is concept in `.agents/jobs/concepts` -> solution plan draft in `.agents/jobs/drafts` -> assistive or autonomous execution -> review -> terminated.
- `assist` in `.agents/jobs/assist` recommends and tracks while the user steers execution.
- Autonomous execution in `.agents/jobs/executing` may move jobs with an obstacle to `.agents/jobs/facilitate` before review.
- `autocode_plan_read` is the canonical handoff reader for drafts and active lifecycle plans.
- `autocode_job_list` scans active lifecycle directories and returns one `jobs` array.
- `autocode_job_status` moves one planned job between logical lifecycle statuses and appends guarded audit entries to `.agents/jobs/*/{job_name}/solution.md`.
- Acceptance criteria use flat top-level `C*`: `metric` mappings only at `.agents/jobs/{status}/{job_name}/criteria.yml`.
- Blank or omitted criteria proof keeps an item active; nonblank proof appends factual completion audit evidence to `solution.md` and removes it from `criteria.yml`.
- Status changes append guarded `Update Status To {status}` entries to `solution.md` with timestamp format `YY-MM-DD hh:mm:ss`.
- Accepted criteria append guarded `Accepted Criteria {criteria}` entries to `solution.md` with timestamp format `YY-MM-DD hh:mm:ss`.
- Action/proof evidence must be factual and must not include Markdown headers.
- Use criteria listing to find unmet items before requesting review.
- Prefer existing utilities before creating new helpers.
- Keep tool error handling aligned with `src/utils/tools.ts` and `src/agents/prompts/error.ts`.
- Model tiers are `cheap`, `fast`, `balanced`, and `smart`.
