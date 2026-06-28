import { tool } from "@opencode-ai/plugin"
import { createContentInsertHandler, createContentMoveHandler, createContentReadHandler, createContentRemoveHandler, createContentTocHandler, createContentWriteHandler, createFrontmatterReadHandler, createFrontmatterWriteHandler } from "./content/engine"
import { createContentGrepHandler } from "./content/grep"
import type { ContentAdapter } from "./content/local_filesystem_adapter"
import { createRemoteSftpContentAdapter } from "./content/remote_sftp_adapter"
import { type SshToolDeps, withSftp } from "./autocode_ssh"


const jsonPathSchema = tool.schema.union([tool.schema.string(), tool.schema.array(tool.schema.union([tool.schema.string(), tool.schema.number().int().min(0)]))])

type RemoteContentArgs = {
    ssh_key: string
    path: string
    [key: string]: unknown
}

type RemoteContentHandler = (args: Record<string, unknown>) => Promise<string>

export function createAutocodeSshContentTocTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: `Read remote SSH/SFTP file table of contents to view file structure when content line number is unknown. Supported formats: Markdown, JSON/JSONC, .env, INI/properties/conf, YAML/YML, and TOML`,
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("Absolute remote .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file path."),
            root: jsonPathSchema.optional().describe("Optional section title, dotted section path, JSON/YAML/TOML/config path, path array, env key, or config key."),
            depth: tool.schema.number().int().min(1).optional().default(100).describe("Sub-section depth: prune subsections after depth from selected root."),
        },
        execute: createRemoteContentExecute(deps, "read SSH content toc", createContentTocHandler),
    })
}

export function createAutocodeSshContentReadTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: `Read remote SSH/SFTP file content when line number is unknown. Supports Markdown section, JSON/JSONC/YAML/TOML value, .env key value, or config key/section.`,
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("Absolute remote file path."),
            section: jsonPathSchema.describe("Section title, exact dotted section path, JSON/YAML/TOML/config path, path array, env key, or config key."),
        },
        execute: createRemoteContentExecute(deps, "read SSH content", createContentReadHandler),
    })
}

export function createAutocodeSshContentWriteTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: `Replace remote SSH/SFTP file content: Supports Markdown section body, JSON/JSONC/YAML/TOML value, .env key value, or config key value.`,
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("Absolute remote file path."),
            section: jsonPathSchema.describe("Section title, exact dotted section path, JSON/YAML/TOML/config path, path array, env key, or config key."),
            content: tool.schema.string().describe("Replacement Markdown content, JSON/JSONC/YAML/TOML value, single-line env value, or config value."),
        },
        execute: createRemoteContentExecute(deps, "write SSH content", createContentWriteHandler),
    })
}

export function createAutocodeSshContentInsertTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: `Insert content into remote SSH/SFTP file: Supports Markdown content, JSON/JSONC/YAML/TOML value, .env key value, or config key value.`,
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("Absolute remote content file path."),
            target: jsonPathSchema.describe("Target section title, exact dotted section path, JSON/YAML/TOML/config path, path array, new env key, or config key."),
            content: tool.schema.string().describe("Markdown, JSON/JSONC/YAML/TOML, single-line env value, or config value content to insert."),
            position: tool.schema.number().int().min(0).optional().describe("Zero-based insertion index. 0 inserts at first position; omitted appends at end."),
        },
        execute: createRemoteContentExecute(deps, "insert SSH content", createContentInsertHandler),
    })
}

export function createAutocodeSshContentMoveTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: `Move content within remote SSH/SFTP file: Supports Markdown section subtree, JSON/JSONC/YAML/TOML node, .env key assignment, or config key/section.`,
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("Absolute remote content file path."),
            section: jsonPathSchema.describe("Section title, exact dotted section path, JSON/YAML/TOML/config path, path array, env key, or config key/section to move."),
            target: jsonPathSchema.describe("Target section title, exact dotted section path, JSON/YAML/TOML/config path, path array, env key, or config key/section."),
            position: tool.schema.number().int().min(0).optional().describe("Zero-based insertion index. 0 moves to first position; omitted appends at end."),
        },
        execute: createRemoteContentExecute(deps, "move SSH content", createContentMoveHandler),
    })
}

export function createAutocodeSshContentRemoveTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: `Remove content from remote SSH/SFTP file: Supports Markdown section subtree, JSON/JSONC/YAML/TOML node, .env key assignment, or config key/section.`,
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("Absolute remote content file path."),
            section: jsonPathSchema.describe("Section title, exact dotted section path, JSON/YAML/TOML/config path, path array, env key, or config key/section to remove."),
        },
        execute: createRemoteContentExecute(deps, "remove SSH content", createContentRemoveHandler),
    })
}

export function createAutocodeSshContentFrontmatterReadTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: `Read raw remote SSH/SFTP Markdown frontmatter text from remote file.`,
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("Absolute remote content file path."),
        },
        execute: createRemoteContentExecute(deps, "read SSH content frontmatter", createFrontmatterReadHandler),
    })
}

export function createAutocodeSshContentFrontmatterWriteTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: `Write or remove raw remote SSH/SFTP Markdown frontmatter text from remote file.`,
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("Absolute remote content file path."),
            frontmatter: tool.schema.string().describe("Raw frontmatter text."),
        },
        execute: createRemoteContentExecute(deps, "write SSH content frontmatter", createFrontmatterWriteHandler),
    })
}

export function createAutocodeSshContentGrepTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: `Search remote SSH/SFTP md/json/jsonc/toml/ini/env/config file by regex and return matching section title or key path names that autocode_ssh_content_read can to read relevant content.`,
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            pattern: tool.schema.string().describe("Regex pattern."),
            path: tool.schema.string().describe("Absolute remote content file path."),
            include: tool.schema.string().optional().describe("Glob include filter, such as **/*.md."),
            limit: tool.schema.number().int().min(1).optional().describe("Max matching sections/results."),
        },
        execute: createRemoteContentExecute(deps, "grep SSH content", createContentGrepHandler),
    })
}

function createRemoteContentExecute(deps: SshToolDeps, failedAction: string, createHandler: (adapter: ContentAdapter) => RemoteContentHandler): (args: RemoteContentArgs) => Promise<string> {
    return async (args: RemoteContentArgs): Promise<string> => {
        return withSftp(args.ssh_key, deps, failedAction, async ({ sftp }) => {
            const handler = createHandler(createRemoteSftpContentAdapter(sftp))
            return handler(args)
        })
    }
}
