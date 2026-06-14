/**
 * @file copy-skill-sources.ts
 * @description Recursively copies "SKILL.md" files from the `src/skills/` folder to the target build folder `dist/skills/`.
 * 
 * Why it is used:
 * Bundles source markdown skills into the compiled distribution folder
 * so they can be autoloaded by OpenCode.
 * 
 * Where it is called:
 * - Mapped to `bun run copy:skills` in package.json.
 * - Called during builds: `bun run build`.
 * - Called in watch mode: `bun run watch`.
 */

import { cp, mkdir, readdir, rm } from "node:fs/promises"
import { dirname, join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = join(rootDir, "src", "skills")
const targetRoot = join(rootDir, "dist", "skills")

async function copySkillSources(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
        const sourcePath = join(directory, entry.name)

        if (entry.isDirectory()) {
            await copySkillSources(sourcePath)
            continue
        }

        if (entry.isFile() && entry.name === "SKILL.md") {
            const targetPath = join(targetRoot, relative(sourceRoot, sourcePath))
            await mkdir(dirname(targetPath), { recursive: true })
            await cp(sourcePath, targetPath)
        }
    }
}

await rm(targetRoot, { recursive: true, force: true })
await copySkillSources(sourceRoot)
