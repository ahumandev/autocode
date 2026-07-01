import { tool } from "@opencode-ai/plugin"
import { createContentInsertHandler, createContentMoveHandler, createContentReadHandler, createContentRemoveHandler, createContentTocHandler, createContentWriteHandler, createFrontmatterReadHandler, createFrontmatterWriteHandler } from "./content/engine"
import { createLocalContentGrepResponse } from "./content/grep"
import { createLocalFilesystemContentAdapter } from "./content/local_filesystem_adapter"


const jsonPathSchema = tool.schema.union([tool.schema.string(), tool.schema.array(tool.schema.union([tool.schema.string(), tool.schema.number().int().min(0)]))])

export function createAutocodeContentTocTool(): ReturnType<typeof tool> {
    return tool({
        description: `Read local file table of contents to view file structure when content line number is unknown. Supported formats: Markdown, JSON/JSONC, .env, INI/properties/conf, YAML/YML, and TOML`,
        args: {
            path: tool.schema.string().describe("Current-working-directory relative .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file path."),
            root: jsonPathSchema.optional().describe("Optional section title, dotted section path, JSON/YAML/TOML/config path, path array, env key, or config key."),
            depth: tool.schema.number().int().min(1).optional().default(100).describe("Sub-section depth: prune subsections after depth from selected root."),
        },
        execute: (args, context) => createContentTocHandler(createLocalFilesystemContentAdapter(context))(args),
    })
}

export function createAutocodeContentReadTool(): ReturnType<typeof tool> {
    return tool({
        description: `Read local file content when line number is unknown. Supports Markdown section, JSON/JSONC/YAML/TOML value, .env key value, or config key/section.`,
        args: {
            path: tool.schema.string().describe("Current-working-directory relative file path to .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf."),
            section: jsonPathSchema.describe("Section title, exact dotted section path, JSON/YAML/TOML/config path, path array, env key, or config key."),
        },
        execute: (args, context) => createContentReadHandler(createLocalFilesystemContentAdapter(context))(args),
    })
}

export function createAutocodeContentWriteTool(): ReturnType<typeof tool> {
    return tool({
        description: `Replace local file content: Supports Markdown section body, JSON/JSONC/YAML/TOML value, .env key value, or config key value.`,
        args: {
            path: tool.schema.string().describe("Current-working-directory relative file path to .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file."),
            section: jsonPathSchema.describe("Section title, exact dotted section path, JSON/YAML/TOML/config path, path array, env key, or config key."),
            content: tool.schema.string().describe("Replacement Markdown content, JSON/JSONC/YAML/TOML value, single-line env value, or config value."),
        },
        execute: (args, context) => createContentWriteHandler(createLocalFilesystemContentAdapter(context))(args),
    })
}

export function createAutocodeContentInsertTool(): ReturnType<typeof tool> {
    return tool({
        description: `Insert content into local file: Supports Markdown content, JSON/JSONC/YAML/TOML value, .env key value, or config key value relative to a target.`,
        args: {
            path: tool.schema.string().describe("Current-working-directory relative .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file."),
            target: jsonPathSchema.describe("Target section title, exact dotted section path, JSON/YAML/TOML/config path, path array, new env key, or config key."),
            content: tool.schema.string().describe("Markdown, JSON/JSONC/YAML/TOML, single-line env value, or config value content to insert."),
            position: tool.schema.number().int().min(0).optional().describe("Zero-based insertion index. 0 inserts at first position; omitted appends at end."),
        },
        execute: (args, context) => createContentInsertHandler(createLocalFilesystemContentAdapter(context))(args),
    })
}

export function createAutocodeContentMoveTool(): ReturnType<typeof tool> {
    return tool({
        description: `Move content within local file: Supports Markdown section subtree, JSON/JSONC/YAML/TOML node, .env key assignment, or config key/section.`,
        args: {
            path: tool.schema.string().describe("Current-working-directory relative .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file."),
            section: jsonPathSchema.describe("Section title, exact dotted section path, JSON/YAML/TOML/config path, path array, env key, or config key/section to move."),
            target: jsonPathSchema.describe("Target section title, exact dotted section path, JSON/YAML/TOML/config path, path array, env key, or config key/section."),
            position: tool.schema.number().int().min(0).optional().describe("Zero-based insertion index. 0 moves to first position; omitted appends at end."),
        },
        execute: (args, context) => createContentMoveHandler(createLocalFilesystemContentAdapter(context))(args),
    })
}

export function createAutocodeContentRemoveTool(): ReturnType<typeof tool> {
    return tool({
        description: `Remove content from local file: Supports Markdown section subtree, JSON/JSONC/YAML/TOML node, .env key assignment, or config key/section.`,
        args: {
            path: tool.schema.string().describe("Current-working-directory relative .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file."),
            section: jsonPathSchema.describe("Section title, exact dotted section path, JSON/YAML/TOML/config path, path array, env key, or config key/section to remove."),
        },
        execute: (args, context) => createContentRemoveHandler(createLocalFilesystemContentAdapter(context))(args),
    })
}

export function createAutocodeContentFrontmatterReadTool(): ReturnType<typeof tool> {
    return tool({
        description: `Read raw Markdown frontmatter text from local file.`,
        args: {
            path: tool.schema.string().describe("Current-working-directory relative .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file path."),
        },
        execute: (args, context) => createFrontmatterReadHandler(createLocalFilesystemContentAdapter(context))(args),
    })
}

export function createAutocodeContentFrontmatterWriteTool(): ReturnType<typeof tool> {
    return tool({
        description: `Write or remove raw Markdown frontmatter text to local file.`,
        args: {
            path: tool.schema.string().describe("Current-working-directory relative .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file path."),
            frontmatter: tool.schema.string().describe("Raw frontmatter text."),
        },
        execute: (args, context) => createFrontmatterWriteHandler(createLocalFilesystemContentAdapter(context))(args),
    })
}

export function createAutocodeContentGrepTool(): ReturnType<typeof tool> {
    return tool({
        description: `Search local md/json/jsonc/toml/ini/env/config file by regex and return matching section title or key path names that autocode_content_read can to read relevant content.`,
        args: {
            pattern: tool.schema.string().describe("Regex pattern."),
            path: tool.schema.string().optional().describe("Current-working-directory relative file or directory path. Defaults to current working directory."),
            include: tool.schema.string().optional().describe("Glob include filter, such as **/*.md."),
            limit: tool.schema.number().int().min(1).optional().describe("Max matching sections/results."),
        },
        execute: (args, context) => createLocalContentGrepResponse(args, context),
    })
}

export { formatJsonPath, parseJsonPath, parseJsonPathString } from "./content/json"
export { availablePaths, parseMarkdown, resolveSection, splitFrontmatter } from "./content/markdown"
