# npm Registry Distribution

Use this guide for the source-repo npm publish flow for AutoCode.

This is different from the local-only deployment note in [`README.md`](../README.md). The README local deployment step is for building `dist/` to test or run the plugin locally. This document is for publishing `@ahumandev/autocode` from this repository to the npm registry through the GitHub Actions workflow.

Goal: confirm npm publish access, complete the one-time initial publish if needed, configure npm Trusted Publisher, and publish AutoCode to npm from a version tag.

## Prerequisites

- You have push access to this GitHub repository.
- You have an npm account that can publish the `@ahumandev/autocode` package.
- You have Bun and Node.js available locally for preflight checks.
- The `test` script in `package.json` runs `bun test src --isolate`; the `--isolate` flag scopes `mock.module` state per test file so the suite is deterministic. Do not remove the flag when running tests locally or in CI.
- You can configure npm Trusted Publisher for this package.

Package details from [`package.json`](../package.json):

- Package name: `@ahumandev/autocode`
- Package scope: `@ahumandev`
- Publish access: `public`
- Published files: `dist/`

---

## Deployment Steps

### ⚠️ Step 1: Confirm this is the npm publish workflow

Use this workflow only when you are publishing the package to npm.

The local-only build flow in the README is:

```bash
bun run build
```

That command prepares local build artifacts, but it does not publish to npm by itself.

Expected result:

```text
dist/ is created for local testing or package publishing
```

### 👤 Step 2: Confirm npm ownership for the package scope

The package name is scoped: `@ahumandev/autocode`. The npm account you use for publishing must already control the `@ahumandev` scope.

Check your npm login locally:

```bash
npm whoami
```

If `npm whoami` returns `E401 Unauthorized`, the npm CLI is not logged in yet.

Log in, then check again:

```bash
npm login
npm whoami
```

Expected result:

```text
<your-npm-username>
```

If the account does not own or have publish rights for the `@ahumandev` scope, fix that in npm before you continue.

### 📦 Step 3: Publish once locally if the package does not exist yet

Do this step only for the first publish, when `@ahumandev/autocode` does not exist on npm yet.

Create a temporary granular npm token from an npm account that can publish `@ahumandev/autocode`.

Then publish locally with the token set only for this shell session:

```bash
export NODE_AUTH_TOKEN="<temporary-granular-token>"
npm publish --access public
unset NODE_AUTH_TOKEN
```

After the publish succeeds, revoke the temporary token immediately in npm.

Expected result:

```text
The package exists on npm and the temporary token is no longer active
```

### 🧰 Step 4: Configure npm Trusted Publisher

After the initial package exists on npm, configure Trusted Publisher for future GitHub Actions publishes.

Sign in to npm as `ahumandev`, then open the package page:

- <https://www.npmjs.com/package/@ahumandev/autocode> → `Settings` → `Trusted publishing`

If a Trusted Publisher entry already exists for this package workflow, remove it and create it again.

Use these npm Trusted Publisher settings:

- Provider: `GitHub Actions`
- Owner: `ahumandev`
- Repository: `autocode`
- Workflow filename: `npm-publish.yml`
- Environment: leave empty
- Allowed action: `npm publish`

Critical notes:

- Enter the workflow filename only: `npm-publish.yml`
- Do not enter `.github/workflows/npm-publish.yml`
- Do not enter `npm publish` in the workflow filename field
- Do not use `.yaml` if the workflow file is `.yml`

Expected result:

```text
npm Trusted Publisher is configured for this repository workflow
```

### 🧪 Step 5: Run local preflight checks

Run the same checks that the package publish flow depends on.

Install dependencies first:

```bash
bun install --frozen-lockfile
```

Then run the package checks:

```bash
bun run test
bun run typecheck
bun run build
bun run verify:package
```

You can also run the full npm prepublish hook directly:

```bash
npm publish --dry-run
```

Expected result:

```text
Tests pass
TypeScript typecheck passes
dist/ is rebuilt
Package artifact verification passes
```

### 📦 Step 6: Know what `prepublishOnly` runs

Before `npm publish`, the package `prepublishOnly` script runs these commands from [`package.json`](../package.json):

```bash
bun run test && bun run typecheck && bun run build && bun run verify:package
```

That means a publish will fail if any of these fail:

- Tests
- TypeScript type checking
- Build output generation
- Package artifact verification

Expected result:

```text
Publish continues only when all prepublishOnly checks succeed
```

### 🏗️ Step 7: Know which package artifacts must exist

The package verification script in [`scripts/verify-package-artifacts.ts`](../scripts/verify-package-artifacts.ts) requires these artifacts and package settings:

- `dist/plugin.js`
- `dist/plugin.d.ts`
- `package.json` has `main: ./dist/plugin.js`
- `package.json` has `types: ./dist/plugin.d.ts`
- `package.json` has `private: false`
- `package.json` has `publishConfig.access: public`
- `package.json` includes `dist` in `files`

Build output also includes copied generated skills under `dist/skills` during the build flow.

Example check:

```bash
ls -R dist
```

Expected result:

```text
dist/plugin.js
dist/plugin.d.ts
dist/skills/...
```

### 🏷️ Step 8: Follow the version and tag rules

The publish workflow in [`.github/workflows/npm-publish.yml`](../.github/workflows/npm-publish.yml) runs automatically only for Git tags that match:

```text
v*
```

Examples:

```text
v0.0.1
v1.2.3
```

The workflow checks out the tagged commit and publishes from that exact tag.

Use a version tag that matches the package release you intend to publish. In practice, this should align with the `version` field in `package.json` for the tagged commit.

Create and push a tag like this:

```bash
git tag v0.0.1
git push origin v0.0.1
```

Expected result:

```text
GitHub Actions starts the npm publish workflow for the pushed tag
```

### 🚀 Step 9: Publish by pushing a version tag

The default publish path is to push a matching `v*` tag.

The workflow does this:

1. Checks out the repository at the tag.
2. Sets up Bun.
3. Sets up Node.js 24 with the npm registry.
4. Upgrades npm to a Trusted-Publishing-capable version (npm CLI >= 11.5.1; currently pinned to `11.18.0`). npm 10.x cannot do OIDC Trusted Publishing.
5. Runs `bun install --frozen-lockfile`.
6. Strips any empty npm `_authToken` written by `setup-node`, so npm performs the OIDC token exchange instead of skipping it.
7. Runs `npm publish --provenance --access public` through npm Trusted Publishing.
8. Creates a GitHub release for the same tag with generated release notes.

Expected result:

```text
Package is published to npm and a GitHub release is created
```

### 🖱️ Step 10: Use the manual `workflow_dispatch` option when needed

The same workflow also supports manual execution through `workflow_dispatch`.

Manual input:

```text
tag
```

The input must be an existing version tag, because the workflow checks out this ref:

```text
ref: <tag input>
```

Use the Actions UI to run the workflow and enter a tag such as:

```text
v0.0.1
```

Expected result:

```text
GitHub Actions publishes and releases from the existing tag you entered
```

### ✅ Step 11: Verify the published package with the OpenCode plugin CLI

After the package is published, verify installation with the OpenCode plugin CLI instead of editing config files manually.

Install the published package globally with:

```bash
opencode plugin @ahumandev/autocode -g
```

To update or replace an existing global install with the latest published package, run:

```bash
opencode plugin @ahumandev/autocode@latest -g -f
```

Local install is optional. Omit `-g` if you want OpenCode to write project-local `.opencode` config instead of a global install.

Expected result:

```text
OpenCode installs or updates the published AutoCode plugin through the plugin CLI
```

---

## What the GitHub workflow does

The npm publish workflow is defined in [`.github/workflows/npm-publish.yml`](../.github/workflows/npm-publish.yml).

It has two triggers:

- Push of a tag matching `v*`
- Manual `workflow_dispatch` with a required `tag` input

It publishes with:

```yaml
run: npm publish --provenance --access public
```

This uses npm Trusted Publishing (OIDC). There is no stored npm token; publish is authorized by exchanging the GitHub Actions OIDC token with the npm registry. Two requirements the workflow enforces:

- npm CLI version: Trusted Publishing requires npm CLI `>= 11.5.1`. The workflow pins npm to `11.18.0` (npm 10.x cannot do OIDC publishing).
- Empty `_authToken` cleanup: `actions/setup-node` with `registry-url` writes an empty `//registry.npmjs.org/:_authToken=` line to `~/.npmrc`. An empty token makes npm skip the OIDC exchange and fail with `E404`. The workflow removes this line before `npm publish`.

It creates a GitHub release with autogenerated notes after publish succeeds.

---

## Troubleshooting

### ⚠️ Trusted Publishing or initial package setup is incomplete

Symptoms:

- `npm publish` fails in GitHub Actions authentication
- The workflow cannot publish a package that does not exist yet

Check:

- The package already exists on npm, or you completed the one-time local first publish
- The workflow runs npm CLI `>= 11.5.1` (npm 10.x cannot do Trusted Publishing)
- The workflow strips the empty `_authToken` from `~/.npmrc` before `npm publish` (see the `E404` section below)
- npm Trusted Publisher is configured with:
  - Provider `GitHub Actions`
  - Owner `ahumandev`
  - Repository `autocode`
  - Workflow filename `npm-publish.yml`
  - Environment empty
  - Allowed action `npm publish`
- The workflow has OIDC permission through `id-token: write`

If you need to create the package for the first time, use a temporary granular token locally, publish once, then revoke the token immediately.

### ⚠️ `E404` after provenance signing or package PUT

Symptoms:

- GitHub Actions shows provenance signing succeeded
- `npm publish` then fails with `E404`, often after the package `PUT`
- npm reports `'@ahumandev/autocode@<version>' is not in this registry`

This `E404` on an existing scoped package almost always means npm never received a valid Trusted Publishing credential, so the registry hides the package. Scoped packages return `404`, not `401`, when unauthenticated. Provenance still signs because Sigstore uses a separate token path. Check in order:

1. npm CLI version is `>= 11.5.1`. npm 10.x (including the earlier `10.8.2` pin) cannot do OIDC Trusted Publishing: it signs provenance, but the registry `PUT` fails. The workflow pins npm to `11.18.0`.
2. The workflow strips the empty `_authToken` from `~/.npmrc` before `npm publish`. `actions/setup-node` with `registry-url` writes `//registry.npmjs.org/:_authToken=` (empty), and npm treats that as "auth already configured" and skips the OIDC exchange.
3. If both above are correct, then the npm Trusted Publisher entry does not match the workflow. Verify every value exactly: Provider `GitHub Actions`, Owner `ahumandev`, Repository `autocode`, Workflow filename `npm-publish.yml`, Environment empty, Allowed action `npm publish`. Delete the entry and recreate it if anything looks off.

### ⚠️ The workflow did not start

Symptoms:

- Pushing a tag does nothing

Check:

- The tag starts with `v`
- The tag was pushed to GitHub
- For manual runs, the `tag` input matches an existing tag

### ⚠️ `prepublishOnly` failed

Symptoms:

- Publish stops before upload

Check locally:

```bash
bun run test
bun run typecheck
bun run build
bun run verify:package
```

Fix the failing command, then retry the publish.

### ⚠️ Package artifact verification failed

Symptoms:

- `verify:package` throws an error

Check:

- `dist/plugin.js` exists
- `dist/plugin.d.ts` exists
- `package.json` still points `main` and `types` to `dist/`
- `private` is `false`
- `publishConfig.access` is `public`
- `files` includes `dist`

### ⚠️ Wrong package version or tag

Symptoms:

- Release tag and package version do not line up

Check:

- The tagged commit contains the intended `package.json` version
- The tag you publish is the release tag you want GitHub to release from
