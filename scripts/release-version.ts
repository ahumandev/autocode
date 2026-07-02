/**
 * @file release-version.ts
 * @description Bumps the package version, verifies a clean release, commits, tags, and pushes.
 *
 * Why it is used:
 * Standardizes the release flow so every published version is built, verified,
 * committed, tagged, and pushed consistently.
 *
 * Where it is called:
 * - Run via `bun run release:version -- <patch|minor|major|x.y.z>` in package.json.
 *
 * Note: pushing the `v*` tag triggers the npm publish GitHub workflow.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const versionArg = process.argv[2]
const validVersionArgPattern = /^(patch|minor|major|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/
const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDir, "..")
const packageJsonPath = resolve(projectRoot, "package.json")

function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  })

  if (result.error !== undefined) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function getCommandOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  })

  if (result.error !== undefined) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  return result.stdout.trim()
}

function readPackageVersion(): string {
  const packageJson: { version: string } = JSON.parse(readFileSync(packageJsonPath, "utf8"))
  return packageJson.version
}

if (process.argv.length !== 3 || !validVersionArgPattern.test(versionArg)) {
  console.error("Usage: bun run release:version -- <patch|minor|major|x.y.z>")
  process.exit(1)
}

runCommand("npm", ["version", versionArg, "--no-git-tag-version"])
runCommand("bun", ["run", "typecheck"])
runCommand("bun", ["run", "build"])
runCommand("bun", ["run", "verify:package"])

const version = readPackageVersion()
const branch = getCommandOutput("git", ["rev-parse", "--abbrev-ref", "HEAD"])

runCommand("git", ["add", "package.json", "bun.lock"])
runCommand("git", ["commit", "-m", `chore: release v${version}`])
runCommand("git", ["tag", "-a", `v${version}`, "-m", `@ahumandev/autocode v${version}`])

console.log(`\nPushing branch '${branch}' and tag 'v${version}' to origin...`)
runCommand("git", ["push", "origin", branch])
runCommand("git", ["push", "origin", `v${version}`])

console.log("\nDone. Pushing the tag triggered the npm publish workflow.")
