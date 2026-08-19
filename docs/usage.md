# Usage

AutoCode is used from inside OpenCode after the plugin is loaded. It is not a standalone application and does not start a web server or expose a local URL. It registers managed agents, slash commands, generated skills, and tools.

### Primary Agents

| Agent | Purpose |
| ---------- | --------------------------------------------------------- |
| 💡 `advise` | Research topics, answer questions, and guide manual work. |
| 📐 `design` | Design and propose solutions. |
| 🤖 `auto` | **Autonomously** solve problems. |
| 🧑‍💻 `assist` | Assist **interactively** to solve problems. |

### Hybrid Workflow

Combinations of Autonomous and Assisted Workflows are also possible as you can switch any time between `auto` and `assist` agents.

For example you may start in `assist` mode and then later when you get busy, switch to `auto` mode so that agent can continue with your plan without your presence or vice versa.

### Commands

| Command              | Purpose                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `/autocode-install`  | Start AutoCode installation checks and remediation.                                       |
| `/assist`            | Same assist session as `/new-assist`.                                                     |
| `/new-advise`        | Create new 💡 advise session to research topics, answer questions, and guide manual work. |
| `/new-design`        | Create new 📐 design session to design solution to problem.                               |
| `/new-auto`          | Create new 🤖 auto session to autonomously solve problems.                                |
| `/new-assist`        | Create new 🧑‍💻 assist session to semi-autonomously assist with problems/improvements.      |
| `/new-fix`           | Create new session to fix errors or requested issues.                                     |

### Job files

Jobs are stored in `.agents/jobs/{status}/{job_name}/`. Valid statuses are `drafts`, `executing`, `facilitate`, `review`, and `shelved`.

| Path          | Purpose                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------- |
| `concept.md`  | Copy of the concept used to design the plan.                                                  |
| `plan.md`     | Solution plan covering problems, requirements, constraints, risks, and the selected proposal. |
| `session.yml` | Persists the OpenCode session ID linked to this job (fallback identity lookup).               |

### Database inspection

AutoCode can inspect environment-configured databases through read-only tools and the hidden database specialist agent. This capability is intended for safe lookup and analysis, not schema changes, joins across multiple tables, or write operations.

- All database access is read-only.
- Reads are limited to a single table at a time.
- Identifiers must be simple schema, table, or field names.
- Supported filter operators are `=`, `!=`, `<`, `<=`, `>`, `>=`, `like`, `in`, and `is_null`.

## See also

- [Configuration](configuration.md) — database and SSH environment variables.
- [Terminology](terminology.md) — job lifecycle terms.
