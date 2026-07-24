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

import type { Dirent } from "node:fs"
import { access, readFile, readdir } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadGitHubSkillInventory, type GitHubSkillInventory } from "../src/skills/github"
import { verifySkillBundleManifest } from "./skill-bundle"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const packageJsonPath = resolve(rootDir, "package.json")
const skillsRoot = resolve(rootDir, "dist", "skills")

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

function isWithinDirectory(filePath: string, directory: string): boolean {
  const pathRelative = relative(directory, filePath)
  return pathRelative !== "" && !pathRelative.startsWith("..") && !pathRelative.includes("\\")
}

function isDeclaredGitHubFile(relativePath: string, inventory: GitHubSkillInventory): boolean {
  return inventory.skills.some((skill) => {
    const skillPrefix = `${skill.relativeInstallPath}/`
    if (relativePath.startsWith(skillPrefix)) return true
    const repositoryRoot = skill.relativeInstallPath.split("/").slice(0, 3).join("/")
    return (skill.legalFiles ?? []).some((legalFile) => {
      const legalPath = `${repositoryRoot}/${legalFile.relativePath}`
      return relativePath === legalPath
    })
  })
}

async function collectGitHubFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const entries: Dirent[] = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectGitHubFiles(entryPath))
      continue
    }
    if (entry.isFile()) {
      files.push(entryPath)
      continue
    }
    throw new Error(`GitHub skill tree contains unsupported entry: ${entryPath}`)
  }
  return files
}

async function verifyGitHubTree(inventory: GitHubSkillInventory): Promise<void> {
  const githubRoot = join(skillsRoot, "github")
  let files: string[]
  try {
    files = await collectGitHubFiles(githubRoot)
  } catch (error) {
    throw new Error(`Missing GitHub skill tree ${githubRoot}: ${(error as Error).message}`)
  }

  for (const filePath of files) {
    const fileRelativePath = relative(skillsRoot, filePath)
    if (!isWithinDirectory(filePath, skillsRoot) || !isDeclaredGitHubFile(fileRelativePath, inventory)) {
      throw new Error(`GitHub skill tree contains file absent from manifest: ${fileRelativePath}`)
    }
  }
}

for (const filePath of requiredFiles) {
  await access(filePath)
}

await verifySkillBundleManifest(skillsRoot)
const githubInventory = await loadGitHubSkillInventory(join(skillsRoot, "github.jsonc"), skillsRoot)
await verifyGitHubTree(githubInventory)

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
