/**
 * @file verify-package-artifacts.ts
 * @description Validates the existence and contents of the package artifacts before publishing the plugin package.
 * 
 * Why it is used:
 * Protects against publishing broken builds by verifying required files exist in `dist/` and checking package.json configurations.
 * 
 * Where it is called:
 * - Run via `bun run verify:package` in package.json.
 * - Run automatically before publishing during the `prepublishOnly` lifecycle hook:
 *   `bun run test && bun run typecheck && bun run build && bun run verify:package`
 */

import { access, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const packageJsonPath = resolve(rootDir, "package.json")

interface PackageJson {
  main?: string;
  types?: string;
  private?: boolean;
  publishConfig?: {
    access?: string;
  };
  files?: string[];
}

const packageJson: PackageJson = JSON.parse(await readFile(packageJsonPath, "utf8"))

const requiredFiles = [
  resolve(rootDir, "dist", "plugin.js"),
  resolve(rootDir, "dist", "plugin.d.ts"),
]

for (const filePath of requiredFiles) {
  await access(filePath)
}

if (packageJson.main !== "./dist/plugin.js") {
  throw new Error(`Expected main to be ./dist/plugin.js, got ${packageJson.main}`)
}

if (packageJson.types !== "./dist/plugin.d.ts") {
  throw new Error(`Expected types to be ./dist/plugin.d.ts, got ${packageJson.types}`)
}

if (packageJson.private !== false) {
  throw new Error("Expected package to be publishable with private set to false")
}

if (packageJson.publishConfig?.access !== "public") {
  throw new Error("Expected publishConfig.access to be public")
}

if (!Array.isArray(packageJson.files) || !packageJson.files.includes("dist")) {
  throw new Error("Expected package files to include dist")
}
