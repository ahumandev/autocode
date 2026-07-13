import path from "node:path"
import { createRetryResponse } from "@/utils/tools"
import {
    sftpReadFile,
    sftpRename,
    sftpUnlink,
    sftpWriteFile,
    type SftpLike,
} from "@/utils/ssh"
import { withSftp, type SshToolDeps } from "../../autocode_ssh"
import { configModeFromExtension } from "../shared/adapter"
import type { ConfigAdapter, ConfigTarget, RetryResult } from "../shared/types"

export function createRemoteConfigAdapter(sftp: SftpLike): ConfigAdapter {
    return {
        async validateConfigPath(input: unknown, failedAction: string = "Read configuration file"): Promise<RetryResult<ConfigTarget>> {
            if (typeof input !== "string" || input.length === 0) {
                return { ok: false, response: createRetryResponse(failedAction, new Error("path required"), "Provide a path.") }
            }
            if (/[*?[\]{}]/.test(input)) {
                return { ok: false, response: createRetryResponse(failedAction, new Error(`glob patterns not allowed: ${input}`), "Provide a concrete file path without wildcard characters (* ? [ ] { }).") }
            }
            const mode = configModeFromExtension(input)
            if (mode === "markdown") {
                return { ok: false, response: createRetryResponse(failedAction, new Error("markdown files not supported by config tools"), "use autocode_md_* tools for markdown files") }
            }
            if (!mode) {
                return { ok: false, response: createRetryResponse(failedAction, new Error(`unsupported file extension: ${input}`), "Use .json/.jsonc/.yaml/.yml/.toml/.ini/.properties/.conf/.env") }
            }
            return { ok: true, value: { absolutePath: input, mode } }
        },
        async read(target: ConfigTarget): Promise<string> {
            return String(await sftpReadFile(sftp, target.absolutePath, "utf8"))
        },
        async write(target: ConfigTarget, raw: string): Promise<void> {
            await safeWriteRemoteConfigFile(sftp, target.absolutePath, raw)
        },
        parseStringContent: true
    }
}

export function createRemoteConfigExecute(
    deps: SshToolDeps,
    failedAction: string,
    flow: (adapter: ConfigAdapter, args: Record<string, unknown>) => Promise<string>,
): (args: Record<string, unknown>) => Promise<string> {
    return async (args: Record<string, unknown>): Promise<string> => {
        const flowArgs: Record<string, unknown> = { ...args, file_path: args.path ?? args.file_path }
        return withSftp(String(args.ssh_key), deps, failedAction, async ({ sftp }) => flow(createRemoteConfigAdapter(sftp), flowArgs))
    }
}

async function safeWriteRemoteConfigFile(sftp: SftpLike, filePath: string, content: string): Promise<void> {
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
