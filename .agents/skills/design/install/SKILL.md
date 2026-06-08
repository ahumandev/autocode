---
name: design_install
description: Use this skill to understand how to install, setup, run or deploy project in local or production environments.
---

# Local Installation

## Prerequisites

1. Install Bun because the repo uses `bun install`, `bun run build`, `bun run watch`, `bun test`, and `bun run typecheck`.
2. Install OpenCode because this repo is loaded as a plugin inside OpenCode.
3. No local port is exposed; all workflow commands run inside OpenCode.

## Local Setup Steps

1. Install dependencies from the repo root so Bun can resolve workspace packages.
   ```bash
   bun install
   ```
   Expected: `node_modules/` and `bun.lock`.

2. Build the distributable plugin so OpenCode can load compiled output.
   ```bash
   bun run build
   ```
   Expected: `dist/plugin.js`, `dist/plugin.d.ts`, `dist/skills/**/SKILL.md`, and `~/.config/opencode/plugins/autocode.js`.

3. Load the built plugin from OpenCode using a file URL or package name.
   ```jsonc
   { "plugin": ["file:///absolute/path/to/autocode/dist/plugin.js"] }
   ```
   Use `{"plugin":["autocode"]}` only after publish/install.

4. Store local model-tuning config in `.opencode/autocode.jsonc`.
   ```jsonc
   {
     "autocode": {
       "tier": "openai",
       "tiers": {
         "openai": {
           "smart": { "model": "openai/gpt-5.5-pro", "variant": "high" },
           "balanced": { "model": "openai/gpt-5.5", "variant": "medium" },
           "fast": { "model": "openai/gpt-5.4-mini", "variant": "low" },
           "cheap": { "model": "openai/gpt-5.4-nano", "variant": "low" }
         }
       }
     }
   }
   ```
   `autocode.tier` selects one named tier set; `cheap` also fills OpenCode `small_model` when missing.

5. Optionally place global defaults in `~/.config/opencode/autocode.jsonc`.
   `worktree/.opencode/autocode.jsonc` overrides global values; a nested `.opencode/autocode.jsonc` overrides both.

## Startup Steps

1. Start watch mode while editing TypeScript so generated plugin files stay current.
   ```bash
   bun run watch
   ```
   Expected: Bun bundling and `tsc --watch` run together.

2. Reload OpenCode after config or plugin changes so the plugin, agents, and tools refresh.

3. Use `research`, `design`, `auto`, and `assist` inside OpenCode; they are the primary user-facing agents.

## Common Project Commands/URLs

1. Build release artifacts when you need the plugin shim or distributable package.
   ```bash
   bun run build
   ```

2. Watch source edits during local development.
   ```bash
   bun run watch
   ```

3. Run the Bun test suite before publishing or updating docs.
   ```bash
   bun test
   ```

4. Run type checks to catch TypeScript issues without emitting files.
   ```bash
   bun run typecheck
   ```

5. Use the canonical workflow `research -> design`, then `design -> auto` or `design -> assist` for planned work. Canonical commands are `/job-concepts`, `/job-design`, `/job-draft`, `/job-execute-assist`, `/job-execute-auto`, `/job-review`, and `/job-terminate`.

6. Keep planned job lifecycle state in canonical locations: `.agents/jobs/concepts/{label}.md`, `.agents/jobs/drafts/{job_name}/`, `.agents/jobs/assist/{job_name}/`, `.agents/jobs/executing/{job_name}/`, `.agents/jobs/facilitate/{job_name}/`, `.agents/jobs/review/{job_name}/`, and `.agents/jobs/terminated/{job_name}/`.
7. Keep active criteria in `.agents/jobs/{status}/{job_name}/criteria.yml`; status changes and accepted criteria append guarded entries to `.agents/jobs/{status}/{job_name}/solution.md`; planned auto sessions live in `.agents/jobs/executing/{job_name}/session.yml`.

# Production Deployment

## Packaging Steps

1. Install dependencies in the release workspace so the build can resolve all inputs.
   ```bash
   bun install
   ```

2. Build the package so `main`, `types`, and `exports` point at generated files.
   ```bash
   bun run build
   ```

3. Keep `dist/` in the published package because OpenCode resolves `dist/plugin.js` and `dist/plugin.d.ts`.

## Deployment Steps

1. Publish or install the package so OpenCode can resolve the `autocode` plugin name.
   ```bash
   npm publish
   ```

2. Configure the target OpenCode host with `{"plugin":["autocode"]}`.

3. Reload OpenCode, then verify with `/job-concepts`, `/job-execute-auto`, or `/job-execute-assist`.

---

**IMPORTANT**: Update `.agents/skills/design/install/SKILL.md` whenever install, build, load, or deployment behavior changes.
