import { tool } from "@opencode-ai/plugin"
import {
    withSftp,
    globToRegExp,
    createGlobSearch,
    walkRemote,
    globEntryMatches,
    stripLeadingSlash,
    statIfExists,
    type SshToolDeps,
    type RemoteEntry,
} from "../../autocode_ssh"
import { sftpReadFile } from "@/utils/ssh"
import { configRead, formatPath, getParser, parseKeyPath, resolvePath } from "../shared/core"
import { configModeFromExtension } from "../shared/adapter"
import { createRetryResponse } from "@/utils/tools"

export function createAutocodeSshConfigReadTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "Read remote config/data files (.json/.jsonc/.yaml/.yml/.toml/.ini/.properties/.conf/.env) over SFTP by glob pattern. Outlines config/data file or drills into specific key_path.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            glob: tool.schema.string().describe("Glob pattern for config files, e.g. '/etc/nginx/**/*.conf' or 'configs/*.json'."),
            key_path: tool.schema.string().optional().describe("Optional dotted path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') to drill into a specific key. Default = root."),
            key_depth: tool.schema.number().int().min(0).optional().default(100).describe("Maximum traversal depth from key_path."),
            subkey_pattern: tool.schema.string().optional().describe("Regex; include nodes whose path has any segment matching it. Default = all."),
            value_pattern: tool.schema.string().optional().describe("Regex; include leaf nodes whose value matches it. Default = all."),
            max_keys: tool.schema.number().int().min(0).optional().default(40).describe("Cap on total output nodes across all matching files."),
            max_value_chars: tool.schema.number().int().min(0).optional().default(40).describe("Truncate string values exceeding max_value_chars, appending '...'"),
        },
        async execute(args): Promise<string> {
            const failedAction = "Read SSH configuration file"

            if (typeof args.glob !== "string" || args.glob.length === 0) {
                return createRetryResponse(failedAction, new Error("glob required"), "Provide a glob pattern.")
            }

            let subkeyPattern: RegExp | undefined
            let valuePattern: RegExp | undefined
            try {
                subkeyPattern = args.subkey_pattern ? new RegExp(String(args.subkey_pattern)) : undefined
                valuePattern = args.value_pattern ? new RegExp(String(args.value_pattern)) : undefined
            } catch (error) {
                return createRetryResponse(failedAction, error, "Fix the regex pattern.")
            }

            return withSftp(String(args.ssh_key), deps, failedAction, async ({ sftp }) => {
                const search = createGlobSearch(String(args.glob))
                const matcher = globToRegExp(search.matchPattern)
                const rootStats = await statIfExists(sftp, search.root).catch(() => undefined)

                const matches: { key: string; absolute: string }[] = []
                await walkRemote(sftp, search.root, async (entry: RemoteEntry) => {
                    if (entry.type !== "file") return true
                    if (!globEntryMatches(matcher, search.matchRoot, entry, rootStats)) return true
                    const key = search.absoluteOutput ? entry.path : stripLeadingSlash(entry.path)
                    const absolute = entry.path.startsWith("/") ? entry.path : `/${entry.path}`
                    matches.push({ key, absolute })
                    return true
                })

                if (matches.length === 0) {
                    return createRetryResponse(failedAction, new Error("no files matched glob: " + args.glob), "Check the glob pattern and path.")
                }

                const file_paths: Record<string, { key_paths: Record<string, string | null>; nodes_shown: number; nodes_total: number }> = {}

                for (const match of matches) {
                    const mode = configModeFromExtension(match.absolute)
                    if (!mode || mode === "markdown") continue

                    let raw: string
                    try {
                        raw = String(await sftpReadFile(sftp, match.absolute, "utf8"))
                    } catch {
                        continue
                    }

                    const parser = getParser(mode)
                    let value: unknown
                    try {
                        value = parser.parse(raw)
                    } catch {
                        continue
                    }

                    if (args.key_path) {
                        const keyPath = parseKeyPath(args.key_path)
                        if (keyPath === null) continue
                        const resolved = resolvePath(value, keyPath)
                        if (!resolved.found) continue
                        value = resolved.value
                    }

                    const result = configRead(value, {
                        keyDepth: typeof args.key_depth === "number" ? args.key_depth : 100,
                        subkeyPattern,
                        valuePattern,
                        maxKeys: typeof args.max_keys === "number" ? args.max_keys : 40,
                        maxValueChars: typeof args.max_value_chars === "number" ? args.max_value_chars : 40,
                    })

                    const key_paths: Record<string, string | null> = {}
                    for (const node of result.nodes) {
                        key_paths[formatPath(node.path)] = node.value
                    }

                    file_paths[match.key] = {
                        key_paths,
                        nodes_shown: result.nodesShown,
                        nodes_total: result.nodesTotal,
                    }
                }

                if (Object.keys(file_paths).length === 0) {
                    return createRetryResponse(failedAction, new Error("no readable config files for glob: " + args.glob), "Check the glob pattern and file formats.")
                }

                return JSON.stringify({ file_paths })
            })
        },
    })
}
