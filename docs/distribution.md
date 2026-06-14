# npm Registry Distribution

Use this guide for the source-repo npm publish flow for AutoCode.

This is different from the local-only deployment note in [`README.md`](../README.md). The README local deployment step is for building `dist/` to test or run the plugin locally. This document is for publishing `@ahumandev/autocode` from this repository to the npm registry through the GitHub Actions workflow.

Goal: register the npm package scope if needed, configure GitHub secrets, and publish AutoCode to npm from a version tag.

## Prerequisites

- You have push access to this GitHub repository.
- You have an npm account that can publish the `@ahumandev/autocode` package.
- You have Bun and Node.js available locally for preflight checks.
- You can create GitHub repository secrets.

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

### 🔐 Step 3: Create an npm publish token

Create an npm token from the npm account that can publish `@ahumandev/autocode`.

Use an npm token that can publish packages for the `@ahumandev` scope.

After creation, keep the token value safe. You will use it as the GitHub Actions secret.

Expected result:

```text
An npm token is available for package publishing
```

### 🧰 Step 4: Add the `NPM_TOKEN` GitHub secret

Add the npm token to this repository as a GitHub Actions secret named `NPM_TOKEN`.

Secret name:

```text
NPM_TOKEN
```

Expected result:

```text
Repository secret NPM_TOKEN exists
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

The package verification script in [`scripts/verify-package-artifacts.mjs`](../scripts/verify-package-artifacts.mjs) requires these artifacts and package settings:

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
3. Sets up Node.js 20 with the npm registry.
4. Runs `bun install --frozen-lockfile`.
5. Runs `npm publish` with `NODE_AUTH_TOKEN` from `NPM_TOKEN`.
6. Creates a GitHub release for the same tag with generated release notes.

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

---

## What the GitHub workflow does

The npm publish workflow is defined in [`.github/workflows/npm-publish.yml`](../.github/workflows/npm-publish.yml).

It has two triggers:

- Push of a tag matching `v*`
- Manual `workflow_dispatch` with a required `tag` input

It publishes with:

```yaml
run: npm publish
env:
  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

It creates a GitHub release with autogenerated notes after publish succeeds.

---

## Troubleshooting

### ⚠️ `NPM_TOKEN` is missing or invalid

Symptoms:

- `npm publish` fails in GitHub Actions authentication

Check:

- Repository secret is named exactly `NPM_TOKEN`
- Token belongs to an npm account that can publish `@ahumandev/autocode`

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
