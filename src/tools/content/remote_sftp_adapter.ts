import path from "node:path"
import type { Stats } from "ssh2"
import { createRetryResponse } from "@/utils/tools"
import { sftpReadFile, sftpRename, sftpStat, sftpUnlink, sftpWriteFile, type SftpLike } from "@/utils/ssh"
import { validateRemotePath, validateWritableRemoteFilePath } from "../autocode_ssh"
import { contentModeFromExtension, type ContentAdapter } from "./local_filesystem_adapter"
import type { ContentTarget, RetryResult } from "./types"

export function createRemoteSftpContentAdapter(sftp: SftpLike): ContentAdapter {
    return {
        validateContentPath(input: unknown): Promise<RetryResult<ContentTarget>> {
            return validateRemoteContentPath(sftp, input)
        },
        validateMarkdownPath(input: unknown): Promise<RetryResult<ContentTarget>> {
            return validateRemoteMarkdownPath(sftp, input)
        },
        async read(target: ContentTarget): Promise<string> {
            return String(await sftpReadFile(sftp, target.absolutePath, "utf8"))
        },
        async write(target: ContentTarget, raw: string): Promise<void> {
            await safeWriteRemoteFile(sftp, target.absolutePath, raw)
        },
    }
}

async function validateRemoteContentPath(sftp: SftpLike, input: unknown): Promise<RetryResult<ContentTarget>> {
    const failedAction = "validate remote content path"
    if (typeof input !== "string") {
        return { ok: false, response: createRetryResponse(failedAction, "path must be a non-empty string.", "Provide an absolute remote content file path.") }
    }

    const pathError = validateContentRemotePath(input, "path")
    if (pathError) return { ok: false, response: createRetryResponse(failedAction, pathError.message, "Provide an absolute remote content file path without wildcards, control characters, or '..' segments.") }

    const mode = contentModeFromExtension(input)
    if (!mode) return { ok: false, response: createRetryResponse(failedAction, "path must use .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf extension/name.", "Retry with a Markdown, JSON, JSONC, YAML, TOML, .env, INI, properties, or .conf remote file path.") }

    const fileStat = await statIfExists(sftp, input)
    if (!fileStat?.isFile()) return { ok: false, response: createRetryResponse(failedAction, `Remote content file not found: ${input}`, "Retry with an existing remote content file path.") }

    return { ok: true, value: { inputPath: input, absolutePath: input, mode } }
}

async function validateRemoteMarkdownPath(sftp: SftpLike, input: unknown): Promise<RetryResult<ContentTarget>> {
    const target = await validateRemoteContentPath(sftp, input)
    if (!target.ok) return target
    if (target.value.mode !== "markdown") return { ok: false, response: createRetryResponse("validate remote content path", "path must use .md extension.", "Retry with a Markdown file path ending in .md.") }
    return target
}

function validateContentRemotePath(value: string, name: string): Error | undefined {
    const writableError = validateWritableRemoteFilePath(value, name)
    if (writableError) return writableError
    const remoteError = validateRemotePath(value, name)
    if (remoteError) return remoteError
    if (!value.startsWith("/")) return new Error(`${name} must be an absolute remote path`)
    if (value.includes("\\")) return new Error(`${name} must use forward slashes`)
    if (/[\x00-\x1F\x7F]/.test(value)) return new Error(`${name} must not contain control characters`)
    if (/[*?[\]{}]/.test(value)) return new Error(`${name} must not contain wildcard characters`)
    if (value.split("/").includes("..")) return new Error(`${name} must not contain '..' path traversal segments`)
    return undefined
}

async function safeWriteRemoteFile(sftp: SftpLike, filePath: string, content: string): Promise<void> {
    const tempPath = siblingWorkPath(filePath, "tmp")
    await sftpWriteFile(sftp, tempPath, content)
    try {
        await sftpRename(sftp, tempPath, filePath)
        return
    }
    catch {
        await cleanupTempFile(sftp, tempPath)
    }

    await backupSafeWrite(sftp, filePath, content)
}

async function backupSafeWrite(sftp: SftpLike, filePath: string, content: string): Promise<void> {
    const backupPath = siblingWorkPath(filePath, "bak")
    const original = String(await sftpReadFile(sftp, filePath, "utf8"))
    // Used only when SFTP rename is unavailable; backup remains if final write or restore fails.
    await sftpWriteFile(sftp, backupPath, original)
    try {
        await sftpWriteFile(sftp, filePath, content)
        await cleanupTempFile(sftp, backupPath)
    }
    catch (error) {
        await sftpWriteFile(sftp, filePath, original).catch(() => undefined)
        throw error
    }
}

function siblingWorkPath(filePath: string, suffix: "tmp" | "bak"): string {
    const directory = path.posix.dirname(filePath)
    const basename = path.posix.basename(filePath)
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    return path.posix.join(directory, `.${basename}.${unique}.${suffix}`)
}

async function cleanupTempFile(sftp: SftpLike, filePath: string): Promise<void> {
    await sftpUnlink(sftp, filePath).catch(() => undefined)
}

async function statIfExists(sftp: SftpLike, filePath: string): Promise<Stats | undefined> {
    try {
        return await sftpStat(sftp, filePath)
    }
    catch (error) {
        if (isMissingPathError(error)) return undefined
        throw error
    }
}

function isMissingPathError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const detail = `${error.name} ${error.message}`.toLowerCase()
    return detail.includes("no such file") || detail.includes("not found") || detail.includes("enoent")
}
