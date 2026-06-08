import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const packageJsonPath = join(rootDir, "package.json")
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"))
const pluginName = String(packageJson.name || "plugin").replace(/^@/, "").replace(/[\\/]+/g, "-")
const distPluginPath = resolve(rootDir, "dist", "plugin.js")
const shimPath = join(homedir(), ".config", "opencode", "plugins", `${pluginName}.js`)
const shimContents = `export { default } from ${JSON.stringify(pathToFileURL(distPluginPath).href)}\n`

await mkdir(dirname(shimPath), { recursive: true })
await writeFile(shimPath, shimContents)
