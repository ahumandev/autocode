import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"

export const SKILL_BUNDLE_MANIFEST = ".bundle-manifest.json"

export type SkillBundleFile = {
    relativePath: string
    sha256: string
}

export type SkillBundleManifest = {
    directories: string[]
    files: SkillBundleFile[]
}

function comparePaths(left: string, right: string): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}

function bundleRelativePath(root: string, path: string): string {
    return relative(root, path).replaceAll("\\", "/")
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSafeRelativePath(value: string): boolean {
    const segments = value.split("/")
    return value !== "" && !value.includes("\\") && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

function bundleError(manifestPath: string, message: string): Error {
    return new Error(`Skill bundle manifest ${manifestPath}: ${message}`)
}

function validateStringArray(value: unknown, key: string, manifestPath: string): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !isSafeRelativePath(item))) {
        throw bundleError(manifestPath, `expected ${key} to be an array of safe relative paths`)
    }
    if (new Set(value).size !== value.length) {
        throw bundleError(manifestPath, `${key} contains duplicate paths`)
    }
    return value
}

function validateFiles(value: unknown, manifestPath: string): SkillBundleFile[] {
    if (!Array.isArray(value)) {
        throw bundleError(manifestPath, "expected files to be an array")
    }
    const paths = new Set<string>()
    return value.map((entry, index) => {
        if (!isRecord(entry) || Object.keys(entry).length !== 2 || typeof entry.relativePath !== "string" || typeof entry.sha256 !== "string") {
            throw bundleError(manifestPath, `expected files[${index}] to contain relativePath and sha256`)
        }
        if (!isSafeRelativePath(entry.relativePath) || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
            throw bundleError(manifestPath, `invalid files[${index}] path or SHA-256 digest`)
        }
        if (paths.has(entry.relativePath)) {
            throw bundleError(manifestPath, `files contains duplicate path "${entry.relativePath}"`)
        }
        paths.add(entry.relativePath)
        return { relativePath: entry.relativePath, sha256: entry.sha256 }
    })
}

export async function createSkillBundleManifest(skillsRoot: string): Promise<SkillBundleManifest> {
    const directories: string[] = []
    const files: SkillBundleFile[] = []

    async function visit(directory: string): Promise<void> {
        const entries: Dirent[] = await readdir(directory, { withFileTypes: true })
        entries.sort((left, right) => comparePaths(left.name, right.name))
        for (const entry of entries) {
            const entryPath = join(directory, entry.name)
            const entryRelativePath = bundleRelativePath(skillsRoot, entryPath)
            if (entryRelativePath === SKILL_BUNDLE_MANIFEST) continue
            if (entry.isDirectory()) {
                directories.push(entryRelativePath)
                await visit(entryPath)
                continue
            }
            if (entry.isFile()) {
                const content = await readFile(entryPath)
                files.push({
                    relativePath: entryRelativePath,
                    sha256: createHash("sha256").update(content).digest("hex"),
                })
                continue
            }
            throw new Error(`Skill bundle ${skillsRoot}: unsupported entry ${entryRelativePath}`)
        }
    }

    await visit(skillsRoot)
    return { directories, files }
}

export async function writeSkillBundleManifest(skillsRoot: string): Promise<void> {
    const manifest = await createSkillBundleManifest(skillsRoot)
    await writeFile(join(skillsRoot, SKILL_BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
}

export async function loadSkillBundleManifest(manifestPath: string): Promise<SkillBundleManifest> {
    let raw: string
    try {
        raw = await readFile(manifestPath, "utf8")
    } catch (error) {
        throw bundleError(manifestPath, `cannot read manifest: ${(error as Error).message}`)
    }

    let value: unknown
    try {
        value = JSON.parse(raw) as unknown
    } catch (error) {
        throw bundleError(manifestPath, `malformed JSON: ${(error as Error).message}`)
    }
    if (!isRecord(value) || Object.keys(value).length !== 2 || !("directories" in value) || !("files" in value)) {
        throw bundleError(manifestPath, "expected root object with directories and files")
    }

    return {
        directories: validateStringArray(value.directories, "directories", manifestPath),
        files: validateFiles(value.files, manifestPath),
    }
}

export async function verifySkillBundleManifest(skillsRoot: string): Promise<SkillBundleManifest> {
    const manifestPath = join(skillsRoot, SKILL_BUNDLE_MANIFEST)
    const manifest = await loadSkillBundleManifest(manifestPath)
    const actual = await createSkillBundleManifest(skillsRoot)
    const expectedDirectories = JSON.stringify(manifest.directories)
    const actualDirectories = JSON.stringify(actual.directories)
    if (expectedDirectories !== actualDirectories) {
        throw bundleError(manifestPath, "directory inventory does not match bundle")
    }
    const expectedFiles = JSON.stringify(manifest.files)
    const actualFiles = JSON.stringify(actual.files)
    if (expectedFiles !== actualFiles) {
        throw bundleError(manifestPath, "file inventory or SHA-256 digest does not match bundle")
    }
    return manifest
}
