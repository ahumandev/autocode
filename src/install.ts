/**
 * @file install.ts
 * @description Installs a local development shim for the OpenCode plugin at ~/.config/opencode/plugins/autocode.js.
 * 
 * Why it is used:
 * Used to link the local development build in `dist/plugin.js` into the OpenCode plugins directory,
 * enabling testing changes locally in OpenCode without publishing.
 * 
 * Where it is called:
 * - Run via `bun run install:shim` (mapped to `bun src/install.ts` in package.json).
 * - Imported and tested by `src/install.test.ts`.
 * 
 * Why it is in src/ instead of scripts/:
 * Because it is imported by tests in `src/`, TypeScript includes it in the compilation program.
 * Since tsconfig.json enforces "rootDir": "src", keeping this script in `scripts/` would trigger
 * a TS6059 compile error. Moving it here keeps the compilation root clean.
 */

import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export interface InstallPluginShimOptions {
  rootDir?: string;
  homeDir?: string;
}

export function deriveShimFilename(packageName: string): string {
  const normalizedName = typeof packageName === "string" ? packageName : ""
  const segments = normalizedName.split("/").filter(Boolean)
  const basename = normalizedName.startsWith("@") ? (segments[1] ?? "") : (segments.at(-1) ?? "")
  const safeBasename = basename.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")

  return `${safeBasename || "plugin"}.js`
}

export function getShimPath(homeDir: string, packageName: string): string {
  return join(homeDir, ".config", "opencode", "plugins", deriveShimFilename(packageName))
}

export async function installPluginShim(options: InstallPluginShimOptions = {}): Promise<string> {
  const installRootDir = options.rootDir ?? rootDir
  const installHomeDir = options.homeDir ?? homedir()
  const packageJsonPath = join(installRootDir, "package.json")
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"))
  const distPluginPath = resolve(installRootDir, "dist", "plugin.js")
  const shimPath = getShimPath(installHomeDir, packageJson.name)
  const shimContents = `export { default } from ${JSON.stringify(pathToFileURL(distPluginPath).href)}\n`

  await mkdir(dirname(shimPath), { recursive: true })
  await writeFile(shimPath, shimContents)

  return shimPath
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installPluginShim()
}
