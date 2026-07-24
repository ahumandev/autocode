/**
 * @file copy-skill-sources.ts
 * @description Creates immutable release skill bundle from local source assets.
 * 
 * Why it is used:
 * Bundles local skill assets into the compiled distribution folder
 * so they can be autoloaded by OpenCode.
 * 
 * Where it is called:
 * - Mapped to `bun run copy:skills` in package.json.
 * - Called during builds: `bun run build`.
 * - Called in watch mode: `bun run watch`.
 */

import type { Dirent } from "node:fs"
import { copyFile, mkdir, readdir, rm } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { writeSkillBundleManifest } from "./skill-bundle"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = join(rootDir, "src", "skills")
const targetRoot = join(rootDir, "dist", "skills")

function isReleaseFile(relativePath: string): boolean {
    return !relativePath.endsWith(".ts") && !relativePath.endsWith(".tsx") && !/\.(test|spec)\.[^/]+$/.test(relativePath)
}

async function copySkillSources(directory: string): Promise<void> {
    const entries: Dirent[] = await readdir(directory, { withFileTypes: true })

    for (const entry of entries) {
        const sourcePath = join(directory, entry.name)
        const sourceRelativePath = relative(sourceRoot, sourcePath)
        const targetPath = join(targetRoot, sourceRelativePath)

        if (entry.isDirectory()) {
            await mkdir(targetPath, { recursive: true })
            await copySkillSources(sourcePath)
            continue
        }

        if (entry.isFile() && isReleaseFile(sourceRelativePath)) {
            await mkdir(dirname(targetPath), { recursive: true })
            await copyFile(sourcePath, targetPath)
            continue
        }

        if (!entry.isFile()) throw new Error(`Unsupported skill source entry: ${sourceRelativePath}`)
    }
}

await rm(targetRoot, { recursive: true, force: true })
await mkdir(targetRoot, { recursive: true })
await copySkillSources(sourceRoot)
await writeSkillBundleManifest(targetRoot)
