import { cp, mkdir, readdir, rm } from "node:fs/promises"
import { dirname, join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = join(rootDir, "src", "skills")
const targetRoot = join(rootDir, "dist", "skills")

async function copySkillSources(directory) {
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
