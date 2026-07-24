import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { parseGitHubSkillUrl } from "@/utils/github"

export const GITHUB_SKILL_CATEGORIES = ["bash", "code", "design", "test"] as const

export type GitHubSkillCategory = (typeof GITHUB_SKILL_CATEGORIES)[number]

export type GitHubSkillInventoryEntry = {
    sourceUrl: string
    resolvedCommit: string
    relativeInstallPath: string
    category: GitHubSkillCategory
    sha256: string
    legalFiles?: GitHubSkillLegalFile[]
}

export type GitHubSkillLegalFile = {
    relativePath: string
    sha256: string
}

export type GitHubSkillInventory = {
    skills: GitHubSkillInventoryEntry[]
}

const ROOT_KEYS = new Set(["skills"])
const ENTRY_KEYS = new Set(["sourceUrl", "resolvedCommit", "relativeInstallPath", "category", "sha256", "legalFiles"])
const COMMIT_SHA_PATTERN = /^[0-9a-fA-F]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function inventoryError(inventoryPath: string, message: string, entryIndex?: number): Error {
    const entryContext = entryIndex === undefined ? "" : ` skills[${entryIndex}]`
    return new Error(`GitHub skill inventory ${inventoryPath}${entryContext}: ${message}`)
}

function validateKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>, inventoryPath: string, entryIndex?: number): void {
    for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) {
            throw inventoryError(inventoryPath, `unexpected key "${key}"`, entryIndex)
        }
    }
}

function validateString(value: unknown, key: string, inventoryPath: string, entryIndex: number): string {
    if (typeof value !== "string") {
        throw inventoryError(inventoryPath, `expected ${key} to be a string`, entryIndex)
    }
    return value
}

function validateInstallPath(relativeInstallPath: string, parsedOwner: string, parsedProject: string, inventoryPath: string, entryIndex: number): void {
    const segments = relativeInstallPath.split("/")
    if (
        relativeInstallPath.includes("\\")
        || segments.length !== 4
        || segments.some((segment) => segment === "" || segment === "." || segment === "..")
        || segments[0] !== "github"
        || segments[1] !== parsedOwner
        || segments[2] !== parsedProject
    ) {
        throw inventoryError(
            inventoryPath,
            "relativeInstallPath must be github/<owner>/<project>/<skill> and match sourceUrl",
            entryIndex,
        )
    }
}

function validateLegalFiles(value: unknown, inventoryPath: string, entryIndex: number): GitHubSkillLegalFile[] | undefined {
    if (value === undefined) {
        return undefined
    }
    if (!Array.isArray(value)) {
        throw inventoryError(inventoryPath, "expected legalFiles to be an array", entryIndex)
    }

    const paths = new Set<string>()
    return value.map((legalFile, legalIndex) => {
        if (!isRecord(legalFile)) {
            throw inventoryError(inventoryPath, `expected legalFiles[${legalIndex}] to be an object`, entryIndex)
        }
        validateKeys(legalFile, new Set(["relativePath", "sha256"]), inventoryPath, entryIndex)
        const relativePath = validateString(legalFile.relativePath, `legalFiles[${legalIndex}].relativePath`, inventoryPath, entryIndex)
        const sha256 = validateString(legalFile.sha256, `legalFiles[${legalIndex}].sha256`, inventoryPath, entryIndex)
        const segments = relativePath.split("/")
        if (relativePath.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
            throw inventoryError(inventoryPath, `legalFiles[${legalIndex}].relativePath must be a safe repository-relative path`, entryIndex)
        }
        if (!SHA256_PATTERN.test(sha256)) {
            throw inventoryError(inventoryPath, `legalFiles[${legalIndex}].sha256 must be a 64-character lowercase hexadecimal SHA-256 digest`, entryIndex)
        }
        if (paths.has(relativePath)) {
            throw inventoryError(inventoryPath, `duplicate legalFiles relativePath "${relativePath}"`, entryIndex)
        }
        paths.add(relativePath)
        return { relativePath, sha256 }
    })
}

function validateEntry(value: unknown, inventoryPath: string, entryIndex: number, installPaths: Set<string>): GitHubSkillInventoryEntry {
    if (!isRecord(value)) {
        throw inventoryError(inventoryPath, "expected entry to be an object", entryIndex)
    }
    validateKeys(value, ENTRY_KEYS, inventoryPath, entryIndex)

    const sourceUrl = validateString(value.sourceUrl, "sourceUrl", inventoryPath, entryIndex)
    const resolvedCommit = validateString(value.resolvedCommit, "resolvedCommit", inventoryPath, entryIndex)
    const relativeInstallPath = validateString(value.relativeInstallPath, "relativeInstallPath", inventoryPath, entryIndex)
    const category = validateString(value.category, "category", inventoryPath, entryIndex)
    const sha256 = validateString(value.sha256, "sha256", inventoryPath, entryIndex)
    const legalFiles = validateLegalFiles(value.legalFiles, inventoryPath, entryIndex)
    const parsedSource = parseGitHubSkillUrl(sourceUrl)

    if (parsedSource.strategy === "invalid") {
        throw inventoryError(inventoryPath, `invalid sourceUrl: ${parsedSource.reason}`, entryIndex)
    }
    if (!COMMIT_SHA_PATTERN.test(resolvedCommit)) {
        throw inventoryError(inventoryPath, "resolvedCommit must be a 40-character Git commit SHA", entryIndex)
    }
    if (!GITHUB_SKILL_CATEGORIES.includes(category as GitHubSkillCategory)) {
        throw inventoryError(inventoryPath, `invalid category "${category}"`, entryIndex)
    }
    if (!SHA256_PATTERN.test(sha256)) {
        throw inventoryError(inventoryPath, "sha256 must be a 64-character lowercase hexadecimal SHA-256 digest", entryIndex)
    }
    validateInstallPath(relativeInstallPath, parsedSource.owner, parsedSource.project, inventoryPath, entryIndex)
    if (installPaths.has(relativeInstallPath)) {
        throw inventoryError(inventoryPath, `duplicate relativeInstallPath "${relativeInstallPath}"`, entryIndex)
    }
    installPaths.add(relativeInstallPath)

    return { sourceUrl, resolvedCommit, relativeInstallPath, category: category as GitHubSkillCategory, sha256, ...(legalFiles === undefined ? {} : { legalFiles }) }
}

export function validateGitHubSkillInventory(value: unknown, inventoryPath: string): GitHubSkillInventory {
    if (!isRecord(value)) {
        throw inventoryError(inventoryPath, "expected root object")
    }
    validateKeys(value, ROOT_KEYS, inventoryPath)
    if (!Array.isArray(value.skills)) {
        throw inventoryError(inventoryPath, "expected skills to be an array")
    }

    const installPaths = new Set<string>()
    const skills = value.skills.map((entry, entryIndex) => validateEntry(entry, inventoryPath, entryIndex, installPaths))
    const legalDigests = new Map<string, string>()
    for (const [entryIndex, entry] of skills.entries()) {
        const source = parseGitHubSkillUrl(entry.sourceUrl)
        if (source.strategy === "invalid") continue
        for (const legalFile of entry.legalFiles ?? []) {
            const destination = `github/${source.owner}/${source.project}/${legalFile.relativePath}`
            const existingDigest = legalDigests.get(destination)
            if (existingDigest !== undefined && existingDigest !== legalFile.sha256) {
                throw inventoryError(inventoryPath, `conflicting legalFiles digest for "${destination}"`, entryIndex)
            }
            legalDigests.set(destination, legalFile.sha256)
        }
    }
    return { skills }
}

function parseGitHubSkillInventory(raw: string, inventoryPath: string): GitHubSkillInventory {
    const errors: ParseError[] = []
    const value = parseJsonc(raw, errors, { allowTrailingComma: true, disallowComments: false })
    if (errors.length > 0) {
        const first = errors[0]
        throw inventoryError(inventoryPath, `malformed JSONC at offset ${first?.offset ?? 0}`)
    }
    return validateGitHubSkillInventory(value, inventoryPath)
}

async function verifySnapshot(entry: GitHubSkillInventoryEntry, inventoryPath: string, skillsRoot: string, entryIndex: number): Promise<void> {
    const resolvedSkillsRoot = resolve(skillsRoot)
    const skillFilePath = resolve(resolvedSkillsRoot, join(entry.relativeInstallPath, "SKILL.md"))
    const snapshotRelativePath = relative(resolvedSkillsRoot, skillFilePath)
    if (snapshotRelativePath === "" || snapshotRelativePath.startsWith("..")) {
        throw inventoryError(inventoryPath, "relativeInstallPath resolves outside skills root", entryIndex)
    }

    let snapshot: Buffer
    try {
        snapshot = await readFile(skillFilePath)
    } catch (error) {
        throw inventoryError(inventoryPath, `cannot read snapshot ${skillFilePath}: ${(error as Error).message}`, entryIndex)
    }

    const digest = createHash("sha256").update(snapshot).digest("hex")
    if (digest !== entry.sha256) {
        throw inventoryError(inventoryPath, `snapshot SHA-256 mismatch for ${skillFilePath}`, entryIndex)
    }

    const source = parseGitHubSkillUrl(entry.sourceUrl)
    if (source.strategy === "invalid") return
    for (const legalFile of entry.legalFiles ?? []) {
        const legalFilePath = resolve(resolvedSkillsRoot, join("github", source.owner, source.project, legalFile.relativePath))
        const legalRelativePath = relative(resolvedSkillsRoot, legalFilePath)
        if (legalRelativePath === "" || legalRelativePath.startsWith("..")) {
            throw inventoryError(inventoryPath, "legalFiles relativePath resolves outside skills root", entryIndex)
        }
        let legalContent: Buffer
        try {
            legalContent = await readFile(legalFilePath)
        } catch (error) {
            throw inventoryError(inventoryPath, `cannot read legal file ${legalFilePath}: ${(error as Error).message}`, entryIndex)
        }
        if (createHash("sha256").update(legalContent).digest("hex") !== legalFile.sha256) {
            throw inventoryError(inventoryPath, `legal file SHA-256 mismatch for ${legalFilePath}`, entryIndex)
        }
    }
}

export async function loadGitHubSkillInventory(inventoryPath: string, skillsRoot: string): Promise<GitHubSkillInventory> {
    let raw: string
    try {
        raw = await readFile(inventoryPath, "utf8")
    } catch (error) {
        throw inventoryError(inventoryPath, `cannot read inventory: ${(error as Error).message}`)
    }

    const inventory = parseGitHubSkillInventory(raw, inventoryPath)
    await Promise.all(inventory.skills.map(async (entry, entryIndex) => {
        await verifySnapshot(entry, inventoryPath, skillsRoot, entryIndex)
    }))
    return inventory
}
