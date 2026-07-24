import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import path from "node:path"
import type { SandboxDependencies } from "@/utils/sandbox"
import { defaultSandboxDependencies } from "@/utils/sandbox"
import { resolveSafeRelativePath, resolveSandboxForFileTool, validateSafeWriteTarget } from "@/utils/sandbox_file_tools"
import type { SessionJobContext } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { expandGlob } from "@/utils/glob"
import { configModeFromExtension } from "./config/adapter"
import { configEditFlow, configRead, configRemoveFlow, formatPath, getParser, parseKeyPath, resolvePath } from "./config/core"
import type { z } from "zod"
import type { ConfigAdapter, ConfigMode, ConfigTarget, JsonValue, RetryResult } from "./config/types"

const configPathSchema = tool.schema.string()
const jsonValueSchema: z.ZodType<JsonValue> = tool.schema.json()
type ConfigFlowArgs = Record<string, unknown> & { file_path: string }

export function createSandboxConfigAdapter(rootPath: string, deps: SandboxDependencies): ConfigAdapter {
    return {
        async validateConfigPath(input: unknown, failedAction: string = "Read configuration file"): Promise<RetryResult<ConfigTarget>> {
            if (typeof input !== "string" || input.length === 0) {
                return { ok: false, response: createRetryResponse(failedAction, new Error("path required"), "Provide a path.") }
            }
            const mode = configModeFromExtension(input)
            if (mode === "markdown") {
                return { ok: false, response: createRetryResponse(failedAction, new Error("markdown files not supported by config tools"), "use autocode_md_* tools for markdown files") }
            }
            if (!mode) {
                return { ok: false, response: createRetryResponse(failedAction, new Error(`unsupported file extension: ${input}`), "Use .json/.jsonc/.yaml/.yml/.toml/.ini/.properties/.conf/.env") }
            }
            const safe = await validateSafeWriteTarget(rootPath, input, "path", true)
            if (!safe.ok) {
                return { ok: false, response: createRetryResponse(failedAction, safe.reason, "Use a sandbox-root-relative file path that stays inside sandbox storage.") }
            }
            return { ok: true, value: { absolutePath: safe.value.absolutePath, mode: mode as ConfigMode } }
        },
        async read(target: ConfigTarget): Promise<string> {
            return deps.fileSystem.readFile(target.absolutePath, "utf8")
        },
        async write(target: ConfigTarget, raw: string): Promise<void> {
            await deps.fileSystem.mkdir(path.dirname(target.absolutePath), { recursive: true })
            await deps.fileSystem.writeFile(target.absolutePath, raw)
        },
        parseStringContent: true,
    }
}

function createSandboxConfigExecute(
    client: OpencodeClient | undefined,
    deps: SandboxDependencies,
    failedAction: string,
    flow: (adapter: ConfigAdapter, args: ConfigFlowArgs) => Promise<string>,
): (args: Record<string, unknown>, context: SessionJobContext) => Promise<string> {
    return async (args: Record<string, unknown>, context: SessionJobContext): Promise<string> => {
        try {
            const sandbox = await resolveSandboxForFileTool(client, context, deps, args.sandbox_name, failedAction)
            if (!sandbox.ok) return sandbox.response
            const adapter = createSandboxConfigAdapter(sandbox.metadata.root_path, deps)
            const configuredPath = args.path ?? args.file_path
            const filePath = typeof configuredPath === "string" ? configuredPath : ""
            const flowArgs: ConfigFlowArgs = { ...args, file_path: filePath }
            return await flow(adapter, flowArgs)
        }
        catch (error) {
            return createAbortResponse(failedAction, error)
        }
    }
}

export function createAutocodeSandboxConfigEditTool(client?: OpencodeClient, deps: SandboxDependencies = defaultSandboxDependencies): ReturnType<typeof tool> {
    return tool({
        description: "Create, replace, or rename key-values in config files (.json/.jsonc/.yaml/.yml/.toml/.ini/.properties/.conf/.env) inside a sandbox's storage.",
        args: {
            sandbox_name: tool.schema.string().describe("Existing sandbox name."),
            path: tool.schema.string().describe("Sandbox-root-relative path to config file."),
            current_key: configPathSchema.optional().describe("Existing dotted key path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') to operate on. If omitted, a new_key must be given (CREATE)."),
            new_key: configPathSchema.optional().describe("Target key path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') for RENAME or CREATE. Must not already exist."),
            content: jsonValueSchema.optional().describe("New value. Accepts string, number, boolean, null, array, or object. Strings are JSON.parsed when possible, else stored as a literal string. Non-string scalars and arrays/objects are stored as-is. Required for REPLACE and CREATE."),
            new_index: tool.schema.number().int().optional().describe("Position when inserting into arrays: 0=first, -1=last/append, N=nth. Ignored for object keys."),
        },
        execute: createSandboxConfigExecute(client, deps, "edit sandbox config file", configEditFlow),
    })
}

export function createAutocodeSandboxConfigRemoveTool(client?: OpencodeClient, deps: SandboxDependencies = defaultSandboxDependencies): ReturnType<typeof tool> {
    return tool({
        description: "Remove a key and its entire subtree from a structured config file inside a sandbox (JSON/JSONC, YAML/YML, TOML, INI/properties/conf, .env). Refuses to remove the root key. Refuses markdown. Path is sandbox-root-relative.",
        args: {
            sandbox_name: tool.schema.string().describe("Existing sandbox name."),
            path: tool.schema.string().describe("Sandbox-root-relative path to the config file."),
            key_path: configPathSchema.describe("Dotted key path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') of the key to remove. Cannot be the document root."),
        },
        execute: createSandboxConfigExecute(client, deps, "remove sandbox config file key", configRemoveFlow),
    })
}

export function createAutocodeSandboxConfigReadTool(client?: OpencodeClient, deps: SandboxDependencies = defaultSandboxDependencies): ReturnType<typeof tool> {
    return tool({
        description: "Read config/data files (.json/.jsonc/.yaml/.yml/.toml/.ini/.properties/.conf/.env) inside a sandbox's storage by glob pattern. Outlines config/data file or drills into specific key_path.",
        args: {
            sandbox_name: tool.schema.string().describe("Existing sandbox name."),
            file_path_glob: tool.schema.string().describe("Sandbox-root-relative glob pattern for config files, e.g. 'configs/**/*.json' or 'package.json'."),
            key_path: tool.schema.string().optional().describe("Optional dotted path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') to drill into a specific key. Default = root."),
            key_depth: tool.schema.number().int().min(0).optional().default(100).describe("Maximum traversal depth from key_path. Default = 100."),
            subkey_regex: tool.schema.string().optional().describe("Regex; find nodes with matching key paths. Default = all."),
            value_regex: tool.schema.string().optional().describe("Regex; find leaf nodes with matching values. Default = all."),
            max_keys: tool.schema.number().int().min(0).optional().default(40).describe("Cap on total output nodes across all matching files. Default = 40."),
            max_value_chars: tool.schema.number().int().min(0).optional().default(40).describe("Truncate string values exceeding max chars by appending '...'. Default = 40."),
        },
        async execute(args, context): Promise<string> {
            const failedAction = "Read sandbox configuration file"
            try {
                if (typeof args.sandbox_name !== "string" || args.sandbox_name.length === 0) {
                    return createRetryResponse(failedAction, new Error("sandbox_name required"), "Provide an existing sandbox name.")
                }
                if (typeof args.file_path_glob !== "string" || args.file_path_glob.length === 0) {
                    return createRetryResponse(failedAction, new Error("glob required"), "Provide a glob pattern.")
                }

                let subkeyPattern: RegExp | undefined
                let valuePattern: RegExp | undefined
                try {
                    subkeyPattern = args.subkey_regex ? new RegExp(String(args.subkey_regex)) : undefined
                    valuePattern = args.value_regex ? new RegExp(String(args.value_regex)) : undefined
                } catch (error) {
                    return createRetryResponse(failedAction, error, "Fix the regex pattern.")
                }

                const sandbox = await resolveSandboxForFileTool(client, context, deps, args.sandbox_name, failedAction)
                if (!sandbox.ok) return sandbox.response
                const rootPath = sandbox.metadata.root_path

                const matches = await expandGlob(String(args.file_path_glob), rootPath)
                if (matches.length === 0) {
                    return createRetryResponse(failedAction, new Error("no files matched glob: " + args.file_path_glob), "Check the glob pattern and path.")
                }

                const file_paths: Record<string, { key_paths: Record<string, string | null>; nodes_shown: number; nodes_total: number }> = {}

                for (const match of matches) {
                    const safe = await resolveSafeRelativePath(rootPath, match.key, "path", true, true)
                    if (!safe.ok) continue
                    const absolute = safe.value.absolutePath

                    const mode = configModeFromExtension(absolute)
                    if (!mode || mode === "markdown") continue

                    let raw: string
                    try {
                        raw = await deps.fileSystem.readFile(absolute, "utf8")
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

                    file_paths[safe.value.relativePath] = {
                        key_paths,
                        nodes_shown: result.nodesShown,
                        nodes_total: result.nodesTotal,
                    }
                }

                if (Object.keys(file_paths).length === 0) {
                    return createRetryResponse(failedAction, new Error("no readable config files for glob: " + args.file_path_glob), "Check the glob pattern and file formats.")
                }

                return JSON.stringify({ file_paths })
            }
            catch (error) {
                return createAbortResponse(failedAction, error)
            }
        },
    })
}
