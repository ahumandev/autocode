import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { duplicateEnvKeyResponse, envSectionInfo, envTocNode, findEnvAssignments, insertEnvAssignment, moveEnvAssignment, parseEnvDocument, removeEnvAssignment, renameEnvAssignment, replaceEnvValue, resolveEnvAssignment, validateEnvKey, validateEnvSingleLine } from "./env"
import { duplicateIniKeyResponse, duplicateIniSectionResponse, findIniAssignments, findIniSections, formatIniPath, iniContent, iniSectionInfo, iniToc, iniTocNode, insertIniAssignment, moveIniTarget, parseIniDocument, parseIniPath, removeIniTarget, renameIniTarget, replaceIniValue, resolveIniTarget, validateIniInsertPath, validateIniSingleLine } from "./ini"
import type { ContentAdapter } from "./local_filesystem_adapter"
import { applyJsonModify, buildJsonTocNode, formatJsonPath, insertJsonContent, jsonSectionInfo, moveJsonContent, parseJsonDocument, parseJsonFragment, parseJsonPath, resolveJsonNode } from "./json"
import { directBodyEnd, ensureBoundary, hasHeading, insertIndex, normalizeFrontmatter, normalizeHeadingLevels, ownBody, parseMarkdown, rebuild, resolveSection, sectionInfo, splitFrontmatter, tocNode, validateHeadingBase } from "./markdown"
import { toErrorMessage, truncateText } from "./shared"
import { buildTomlToc, formatTomlPath, insertTomlContent, moveTomlContent, parseTomlDocument, parseTomlPath, removeTomlContent, resolveTomlNode, tomlNodeContent, tomlSectionInfo, writeTomlContent } from "./toml"
import { type ContentPosition, type ContentTarget, type EnvModel, type IniModel, type JsonModel, type MarkdownModel, type OptionalRetryResult, type TomlModel, type YamlModel } from "./types"
import { buildYamlTocNode, formatYamlPath, insertYamlContent, moveYamlContent, parseYamlDocument, parseYamlFragment, parseYamlPath, removeYamlContent, resolveYamlNode, validateYamlWriteSize, writeYamlNode, yamlNodeContent, yamlSectionInfo } from "./yaml"

type ToolArgs = Record<string, unknown>
type ContentHandler<T extends ToolArgs> = (args: T) => Promise<string>
type MarkdownHandler<T extends ToolArgs> = (target: ContentTarget, model: MarkdownModel, args: T) => Promise<string>
type JsonHandler<T extends ToolArgs> = (target: ContentTarget, model: JsonModel, args: T) => Promise<string>
type YamlHandler<T extends ToolArgs> = (target: ContentTarget, model: YamlModel, args: T) => Promise<string>
type EnvHandler<T extends ToolArgs> = (target: ContentTarget, model: EnvModel, args: T) => Promise<string>
type IniHandler<T extends ToolArgs> = (target: ContentTarget, model: IniModel, args: T) => Promise<string>
type TomlHandler<T extends ToolArgs> = (target: ContentTarget, model: TomlModel, args: T) => Promise<string>

export function normalizeDepth(input: unknown): OptionalRetryResult<number> {
    if (input === undefined) return { ok: true }
    if (typeof input !== "number" || !Number.isInteger(input) || input <= 0) {
        return { ok: false, response: createRetryResponse("validate content depth", "depth must be a positive integer.", "Retry with depth as a positive integer or omit it.") }
    }
    return { ok: true, value: input }
}

export function normalizePosition(input: unknown): { ok: true, value: ContentPosition } | { ok: false, response: string } {
    if (input === undefined) return { ok: true, value: undefined }
    if (typeof input === "number" && Number.isInteger(input) && input >= 0) return { ok: true, value: input }
    return { ok: false, response: createRetryResponse("validate content position", "position must be a non-negative integer or omitted.", "Retry with a non-negative integer position or omit it to append at end.") }
}

export function createContentEditHandler<T extends ToolArgs>(adapter: ContentAdapter, failedAction: string, markdownHandler: MarkdownHandler<T>, jsonHandler: JsonHandler<T>, yamlHandler: YamlHandler<T>, envHandler: EnvHandler<T>, iniHandler: IniHandler<T>, tomlHandler: TomlHandler<T>): ContentHandler<T> {
    return async (args: T): Promise<string> => {
        try {
            const target = await adapter.validateContentPath(args.path)
            if (!target.ok) return target.response
            if (target.value.mode === "markdown") {
                try {
                    return await markdownHandler(target.value, parseMarkdown(await adapter.read(target.value)), args)
                }
                catch (error) {
                    return createRetryResponse("parse markdown sections", toErrorMessage(error), "Fix the Markdown headings so the file has exactly one H1 root, then retry.")
                }
            }
            if (target.value.mode === "env") return await envHandler(target.value, parseEnvDocument(await adapter.read(target.value)), args)
            if (target.value.mode === "ini") return await iniHandler(target.value, parseIniDocument(await adapter.read(target.value)), args)
            if (target.value.mode === "toml") return await tomlHandler(target.value, parseTomlDocument(await adapter.read(target.value)), args)
            if (target.value.mode === "yaml") {
                try {
                    return await yamlHandler(target.value, parseYamlDocument(await adapter.read(target.value)), args)
                }
                catch (error) {
                    return createRetryResponse("parse yaml content", toErrorMessage(error), "Fix the YAML document, then retry.")
                }
            }
            try {
                return await jsonHandler(target.value, parseJsonDocument(await adapter.read(target.value)), args)
            }
            catch (error) {
                return createRetryResponse("parse json content", toErrorMessage(error), "Fix the JSON/JSONC document, then retry.")
            }
        }
        catch (error) {
            return createAbortResponse(failedAction, toErrorMessage(error))
        }
    }
}

export function createContentTocHandler(adapter: ContentAdapter): ContentHandler<ToolArgs> {
    return createContentEditHandler(adapter, "read content toc", async (target, model, args) => {
        const depth = normalizeDepth(args.depth)
        if (!depth.ok) return depth.response
        const root = args.root === undefined ? { ok: true as const, value: model.root } : resolveSection(model, args.root)
        if (!root.ok) return root.response
        return JSON.stringify({ path: target.inputPath, root: root.value.path, depth: depth.value, toc: tocNode(root.value, depth.value), truncated: false })
    }, async (target, model, args) => {
        const depth = normalizeDepth(args.depth)
        if (!depth.ok) return depth.response
        const rootPath = parseJsonPath(args.root, "root", true)
        if (!rootPath.ok) return rootPath.response
        const root = resolveJsonNode(model, rootPath.value ?? [])
        if (!root) return createRetryResponse("resolve json root", `Root not found: ${formatJsonPath(rootPath.value ?? [])}`, "Retry with an existing JSON path.")
        return JSON.stringify({ path: target.inputPath, root: rootPath.value === undefined ? undefined : formatJsonPath(rootPath.value), depth: depth.value, toc: buildJsonTocNode(model, root.node, root.path, depth.value, root.path.length === 0 ? "$" : undefined, 1), truncated: false })
    }, async (target, model, args) => {
        const depth = normalizeDepth(args.depth)
        if (!depth.ok) return depth.response
        const rootPath = parseYamlPath(args.root, "root", true)
        if (!rootPath.ok) return rootPath.response
        const root = resolveYamlNode(model, rootPath.value ?? [])
        if (!root) return createRetryResponse("resolve yaml root", `Root not found: ${formatYamlPath(rootPath.value ?? [])}`, "Retry with an existing YAML path.")
        const toc = buildYamlTocNode(model, root.node, root.path, depth.value, root.path.length === 0 ? "$" : undefined, 1)
        return JSON.stringify({ path: target.inputPath, root: rootPath.value === undefined ? undefined : formatYamlPath(rootPath.value), depth: depth.value, toc: toc.node, truncated: toc.truncated })
    }, async (target, model, args) => {
        const depth = normalizeDepth(args.depth)
        if (!depth.ok) return depth.response
        const root = args.root === undefined ? undefined : validateEnvKey(args.root, "root", "resolve env root")
        if (root !== undefined && !root.ok) return root.response
        if (root?.value !== undefined) {
            const matches = findEnvAssignments(model, root.value)
            if (matches.length > 1) return duplicateEnvKeyResponse("resolve env root", root.value, matches)
            if (matches.length === 0) return createRetryResponse("resolve env root", `Root not found: ${root.value}`, "Retry with an existing env key.")
            return JSON.stringify({ path: target.inputPath, root: root.value, depth: depth.value, toc: envTocNode(matches[0]), truncated: false })
        }
        return JSON.stringify({ path: target.inputPath, root: undefined, depth: depth.value, toc: model.assignments.map(envTocNode), truncated: false })
    }, async (target, model, args) => {
        const depth = normalizeDepth(args.depth)
        if (!depth.ok) return depth.response
        if (args.root !== undefined) {
            const rootPath = parseIniPath(args.root, model, "root", "resolve config root")
            if (!rootPath.ok) return rootPath.response
            const root = resolveIniTarget(model, rootPath.value, "resolve config root", "Root")
            if (!root.ok) return root.response
            return JSON.stringify({ path: target.inputPath, root: formatIniPath(rootPath.value), depth: depth.value, toc: iniTocNode(model, root.value), truncated: false })
        }
        return JSON.stringify({ path: target.inputPath, root: undefined, depth: depth.value, toc: iniToc(model), truncated: false })
    }, async (target, model, args) => {
        const depth = normalizeDepth(args.depth)
        if (!depth.ok) return depth.response
        const rootPath = parseTomlPath(args.root, "root", true, "resolve toml root")
        if (!rootPath.ok) return rootPath.response
        if (rootPath.value !== undefined) {
            const root = resolveTomlNode(model, rootPath.value, "resolve toml root", "Root")
            if (!root.ok) return root.response
        }
        const toc = buildTomlToc(model, rootPath.value, depth.value)
        return JSON.stringify({ path: target.inputPath, root: rootPath.value === undefined ? undefined : formatTomlPath(rootPath.value), depth: depth.value, toc: toc.toc, truncated: toc.truncated })
    })
}

export function createContentReadHandler(adapter: ContentAdapter): ContentHandler<ToolArgs> {
    return createContentEditHandler(adapter, "read content", async (target, model, args) => {
        const section = resolveSection(model, args.section)
        if (!section.ok) return section.response
        const content = truncateText(ownBody(model, section.value))
        return JSON.stringify({ path: target.inputPath, section: sectionInfo(section.value), content: content.value, truncated: content.truncated })
    }, async (target, model, args) => {
        const sectionPath = parseJsonPath(args.section, "section", false)
        if (!sectionPath.ok) return sectionPath.response
        const section = resolveJsonNode(model, sectionPath.value ?? [])
        if (!section) return createRetryResponse("resolve json section", `Section not found: ${formatJsonPath(sectionPath.value ?? [])}`, "Retry with an existing JSON path.")
        const content = truncateText(model.raw.slice(section.node.offset, section.node.offset + section.node.length))
        return JSON.stringify({ path: target.inputPath, section: jsonSectionInfo(model, section), content: content.value, truncated: content.truncated })
    }, async (target, model, args) => {
        const sectionPath = parseYamlPath(args.section, "section", false)
        if (!sectionPath.ok) return sectionPath.response
        const section = resolveYamlNode(model, sectionPath.value ?? [])
        if (!section) return createRetryResponse("resolve yaml section", `Section not found: ${formatYamlPath(sectionPath.value ?? [])}`, "Retry with an existing YAML path.")
        const content = truncateText(yamlNodeContent(model, section.node))
        return JSON.stringify({ path: target.inputPath, section: yamlSectionInfo(model, section), content: content.value, truncated: content.truncated })
    }, async (target, model, args) => {
        const key = validateEnvKey(args.section, "section", "resolve env section")
        if (!key.ok) return key.response
        const section = resolveEnvAssignment(model, key.value, "resolve env section", "Section")
        if (!section.ok) return section.response
        const content = truncateText(model.raw.slice(section.value.valueStart, section.value.valueEnd))
        return JSON.stringify({ path: target.inputPath, section: envSectionInfo(section.value), content: content.value, truncated: content.truncated })
    }, async (target, model, args) => {
        const sectionPath = parseIniPath(args.section, model, "section", "resolve config section")
        if (!sectionPath.ok) return sectionPath.response
        const section = resolveIniTarget(model, sectionPath.value, "resolve config section", "Section")
        if (!section.ok) return section.response
        const content = truncateText(iniContent(model, section.value))
        return JSON.stringify({ path: target.inputPath, section: iniSectionInfo(section.value), content: content.value, truncated: content.truncated })
    }, async (target, model, args) => {
        const sectionPath = parseTomlPath(args.section, "section", false, "resolve toml section")
        if (!sectionPath.ok) return sectionPath.response
        const section = resolveTomlNode(model, sectionPath.value ?? [], "resolve toml section", "Section")
        if (!section.ok) return section.response
        const content = truncateText(tomlNodeContent(model, section.value))
        return JSON.stringify({ path: target.inputPath, section: tomlSectionInfo(model, section.value), content: content.value, truncated: content.truncated })
    })
}

export function createContentWriteHandler(adapter: ContentAdapter): ContentHandler<ToolArgs> {
    return createContentEditHandler(adapter, "write content", async (target, model, args) => {
        if (typeof args.content !== "string") return createRetryResponse("write markdown content", "content must be a string.", "Retry with Markdown content as a string.")
        const section = resolveSection(model, args.section)
        if (!section.ok) return section.response
        const headingBaseError = validateHeadingBase(section.value.level + 1, args.content, "write markdown content")
        if (headingBaseError) return headingBaseError
        const content = normalizeHeadingLevels(ensureBoundary(args.content, model.newline), section.value.level + 1)
        const body = `${model.body.slice(0, section.value.headerEnd)}${content}${model.body.slice(directBodyEnd(section.value))}`
        await writeMarkdownBody(adapter, target, model, body)
        const updated = parseMarkdown(rebuild(model, body))
        const resolved = resolveSection(updated, section.value.title)
        return JSON.stringify({ path: target.inputPath, section: resolved.ok ? resolved.value.path : section.value.path, changed: true, truncated: false })
    }, async (target, model, args) => {
        const fragment = parseJsonFragment(args.content, "write json content", false)
        if (!fragment.ok) return fragment.response
        const sectionPath = parseJsonPath(args.section, "section", false)
        if (!sectionPath.ok) return sectionPath.response
        if (!resolveJsonNode(model, sectionPath.value ?? [])) return createRetryResponse("resolve json section", `Section not found: ${formatJsonPath(sectionPath.value ?? [])}`, "Retry with an existing JSON path.")
        await adapter.write(target, applyJsonModify(model, sectionPath.value ?? [], fragment.value.value))
        return JSON.stringify({ path: target.inputPath, section: formatJsonPath(sectionPath.value ?? []), changed: true, truncated: false })
    }, async (target, model, args) => {
        const sizeError = validateYamlWriteSize(model, "write yaml content")
        if (sizeError) return sizeError
        const fragment = parseYamlFragment(args.content, "write yaml content", false)
        if (!fragment.ok) return fragment.response
        const sectionPath = parseYamlPath(args.section, "section", false)
        if (!sectionPath.ok) return sectionPath.response
        const next = writeYamlNode(model, sectionPath.value ?? [], fragment.value)
        if (!next.ok) return next.response
        await adapter.write(target, next.value)
        return JSON.stringify({ path: target.inputPath, section: formatYamlPath(sectionPath.value ?? []), changed: true, truncated: false })
    }, async (target, model, args) => {
        const content = validateEnvSingleLine(args.content, "write env content")
        if (!content.ok) return content.response
        const key = validateEnvKey(args.section, "section", "resolve env section")
        if (!key.ok) return key.response
        const section = resolveEnvAssignment(model, key.value, "resolve env section", "Section")
        if (!section.ok) return section.response
        await adapter.write(target, replaceEnvValue(model, section.value, content.value))
        return JSON.stringify({ path: target.inputPath, section: section.value.key, changed: true, truncated: false })
    }, async (target, model, args) => {
        const content = validateIniSingleLine(args.content, "write config content")
        if (!content.ok) return content.response
        const sectionPath = parseIniPath(args.section, model, "section", "resolve config section")
        if (!sectionPath.ok) return sectionPath.response
        const section = resolveIniTarget(model, sectionPath.value, "resolve config section", "Section")
        if (!section.ok) return section.response
        if (section.value.assignment === undefined) return createRetryResponse("write config content", `Section is not a key: ${section.value.path}`, "Retry with a config key path.")
        await adapter.write(target, replaceIniValue(model, section.value.assignment, content.value))
        return JSON.stringify({ path: target.inputPath, section: section.value.path, changed: true, truncated: false })
    }, async (target, model, args) => {
        if (typeof args.content !== "string") return createRetryResponse("write toml content", "content must be a string.", "Retry with TOML content as a string.")
        const sectionPath = parseTomlPath(args.section, "section", false, "resolve toml section")
        if (!sectionPath.ok) return sectionPath.response
        const next = writeTomlContent(model, sectionPath.value ?? [], args.content)
        if (!next.ok) return next.response
        await adapter.write(target, next.value)
        return JSON.stringify({ path: target.inputPath, section: formatTomlPath(sectionPath.value ?? []), changed: true, truncated: false })
    })
}

export function createContentInsertHandler(adapter: ContentAdapter): ContentHandler<ToolArgs> {
    return createContentEditHandler(adapter, "insert content", async (targetPath, model, args) => {
        if (typeof args.content !== "string" || args.content === "") return createRetryResponse("insert markdown content", "content must be a non-empty string.", "Retry with Markdown content to insert.")
        const target = resolveSection(model, args.target)
        if (!target.ok) return target.response
        const position = normalizePosition(args.position)
        if (!position.ok) return position.response
        const baseLevel = target.value.level + 1
        const headingBaseError = validateHeadingBase(baseLevel, args.content, "insert markdown content")
        if (headingBaseError) return headingBaseError
        const inserted = hasHeading(args.content) ? normalizeHeadingLevels(ensureBoundary(args.content, model.newline), baseLevel) : ensureBoundary(args.content, model.newline)
        const index = insertIndex(target.value, position.value, hasHeading(args.content))
        const body = `${model.body.slice(0, index)}${inserted}${model.body.slice(index)}`
        await writeMarkdownBody(adapter, targetPath, model, body)
        return JSON.stringify({ path: targetPath.inputPath, target: target.value.path, position: position.value, changed: true, truncated: false })
    }, async (targetPath, model, args) => {
        const fragment = parseJsonFragment(args.content, "insert json content", true)
        if (!fragment.ok) return fragment.response
        const targetPathValue = parseJsonPath(args.target, "target", false)
        if (!targetPathValue.ok) return targetPathValue.response
        const target = resolveJsonNode(model, targetPathValue.value ?? [])
        if (!target) return createRetryResponse("resolve json target", `Target not found: ${formatJsonPath(targetPathValue.value ?? [])}`, "Retry with an existing JSON path.")
        const position = normalizePosition(args.position)
        if (!position.ok) return position.response
        const next = insertJsonContent(model, target, fragment.value, position.value)
        if (!next.ok) return next.response
        await adapter.write(targetPath, next.value)
        return JSON.stringify({ path: targetPath.inputPath, target: formatJsonPath(target.path), position: position.value, changed: true, truncated: false })
    }, async (targetPath, model, args) => {
        const sizeError = validateYamlWriteSize(model, "insert yaml content")
        if (sizeError) return sizeError
        const fragment = parseYamlFragment(args.content, "insert yaml content", true)
        if (!fragment.ok) return fragment.response
        const targetPathValue = parseYamlPath(args.target, "target", false)
        if (!targetPathValue.ok) return targetPathValue.response
        const target = resolveYamlNode(model, targetPathValue.value ?? [])
        if (!target) return createRetryResponse("resolve yaml target", `Target not found: ${formatYamlPath(targetPathValue.value ?? [])}`, "Retry with an existing YAML path.")
        const position = normalizePosition(args.position)
        if (!position.ok) return position.response
        const next = insertYamlContent(model, target, fragment.value, position.value)
        if (!next.ok) return next.response
        await adapter.write(targetPath, next.value)
        return JSON.stringify({ path: targetPath.inputPath, target: formatYamlPath(target.path), position: position.value, changed: true, truncated: false })
    }, async (targetPath, model, args) => {
        const key = validateEnvKey(args.target, "target", "insert env content")
        if (!key.ok) return key.response
        const content = validateEnvSingleLine(args.content, "insert env content")
        if (!content.ok) return content.response
        const existing = findEnvAssignments(model, key.value)
        if (existing.length > 0) return duplicateEnvKeyResponse("insert env content", key.value, existing)
        const position = normalizePosition(args.position)
        if (!position.ok) return position.response
        await adapter.write(targetPath, insertEnvAssignment(model, key.value, content.value, position.value))
        return JSON.stringify({ path: targetPath.inputPath, target: key.value, position: position.value, changed: true, truncated: false })
    }, async (targetPath, model, args) => {
        const target = parseIniPath(args.target, model, "target", "insert config content")
        if (!target.ok) return target.response
        const insertPath = validateIniInsertPath(target.value, "insert config content")
        if (!insertPath.ok) return insertPath.response
        const pathValue = insertPath.value
        if (pathValue === undefined) return createRetryResponse("insert config content", "target must include a config key.", "Retry with a key path like [section,key] or section.key.")
        const content = validateIniSingleLine(args.content, "insert config content")
        if (!content.ok) return content.response
        const existing = findIniAssignments(model, pathValue)
        if (existing.length > 0) return duplicateIniKeyResponse("insert config content", pathValue, existing)
        if (pathValue.section !== undefined) {
            const sections = findIniSections(model, pathValue.section)
            if (sections.length > 1) return duplicateIniSectionResponse("insert config content", pathValue.section, sections)
        }
        const position = normalizePosition(args.position)
        if (!position.ok) return position.response
        await adapter.write(targetPath, insertIniAssignment(model, pathValue, content.value, position.value))
        return JSON.stringify({ path: targetPath.inputPath, target: formatIniPath(pathValue), position: position.value, changed: true, truncated: false })
    }, async (targetPath, model, args) => {
        if (typeof args.content !== "string" || args.content === "") return createRetryResponse("insert toml content", "content must be a non-empty string.", "Retry with TOML content to insert.")
        const targetPathValue = parseTomlPath(args.target, "target", false, "resolve toml target")
        if (!targetPathValue.ok) return targetPathValue.response
        const target = resolveTomlNode(model, targetPathValue.value ?? [], "resolve toml target", "Target")
        if (!target.ok) return target.response
        const position = normalizePosition(args.position)
        if (!position.ok) return position.response
        const next = insertTomlContent(model, target.value, args.content, position.value)
        if (!next.ok) return next.response
        await adapter.write(targetPath, next.value)
        return JSON.stringify({ path: targetPath.inputPath, target: formatTomlPath(target.value.path), position: position.value, changed: true, truncated: false })
    })
}

export function createContentMoveHandler(adapter: ContentAdapter): ContentHandler<ToolArgs> {
    return createContentEditHandler(adapter, "move content", async (targetPath, model, args) => {
        const section = resolveSection(model, args.section)
        if (!section.ok) return section.response
        const target = resolveSection(model, args.target)
        if (!target.ok) return target.response
        const position = normalizePosition(args.position)
        if (!position.ok) return position.response
        if (section.value.level === 1) return createRetryResponse("move markdown content", "Cannot move the H1 root.", "Move a non-root section instead.")
        if (target.value.path === section.value.path || target.value.path.startsWith(`${section.value.path}.`)) return createRetryResponse("move markdown content", "Cannot move a section into itself or a descendant.", "Choose a target outside the moved section subtree.")

        const removedBody = `${model.body.slice(0, section.value.start)}${model.body.slice(section.value.end)}`
        const adjustedTarget = parseMarkdown(rebuild(model, removedBody)).headings.find((heading) => heading.path === target.value.path)
        if (!adjustedTarget) return createRetryResponse("move markdown content", "Target section changed while moving content.", "Retry the move with current exact section paths.")
        const baseLevel = adjustedTarget.level + 1
        const headingBaseError = validateHeadingBase(baseLevel, model.body.slice(section.value.start, section.value.end), "move markdown content")
        if (headingBaseError) return headingBaseError
        const moved = normalizeHeadingLevels(model.body.slice(section.value.start, section.value.end), baseLevel)
        const index = insertIndex(adjustedTarget, position.value, true)
        const body = `${removedBody.slice(0, index)}${moved}${removedBody.slice(index)}`
        await writeMarkdownBody(adapter, targetPath, model, body)
        return JSON.stringify({ path: targetPath.inputPath, section: section.value.path, target: target.value.path, position: position.value, changed: true, truncated: false })
    }, async (targetPath, model, args) => {
        const sectionPath = parseJsonPath(args.section, "section", false)
        if (!sectionPath.ok) return sectionPath.response
        const targetPathValue = parseJsonPath(args.target, "target", false)
        if (!targetPathValue.ok) return targetPathValue.response
        const section = resolveJsonNode(model, sectionPath.value ?? [])
        const target = resolveJsonNode(model, targetPathValue.value ?? [])
        if (!section) return createRetryResponse("resolve json section", `Section not found: ${formatJsonPath(sectionPath.value ?? [])}`, "Retry with an existing JSON path.")
        if (!target) return createRetryResponse("resolve json target", `Target not found: ${formatJsonPath(targetPathValue.value ?? [])}`, "Retry with an existing JSON path.")
        const position = normalizePosition(args.position)
        if (!position.ok) return position.response
        const moved = moveJsonContent(model, section, target, position.value)
        if (!moved.ok) return moved.response
        await adapter.write(targetPath, moved.value)
        return JSON.stringify({ path: targetPath.inputPath, section: formatJsonPath(section.path), target: formatJsonPath(target.path), position: position.value, changed: true, truncated: false })
    }, async (targetPath, model, args) => {
        const sizeError = validateYamlWriteSize(model, "move yaml content")
        if (sizeError) return sizeError
        const sectionPath = parseYamlPath(args.section, "section", false)
        if (!sectionPath.ok) return sectionPath.response
        const targetPathValue = parseYamlPath(args.target, "target", false)
        if (!targetPathValue.ok) return targetPathValue.response
        const section = resolveYamlNode(model, sectionPath.value ?? [])
        const target = resolveYamlNode(model, targetPathValue.value ?? [])
        if (!section) return createRetryResponse("resolve yaml section", `Section not found: ${formatYamlPath(sectionPath.value ?? [])}`, "Retry with an existing YAML path.")
        if (!target) return createRetryResponse("resolve yaml target", `Target not found: ${formatYamlPath(targetPathValue.value ?? [])}`, "Retry with an existing YAML path.")
        const position = normalizePosition(args.position)
        if (!position.ok) return position.response
        const moved = moveYamlContent(model, section, target, position.value)
        if (!moved.ok) return moved.response
        await adapter.write(targetPath, moved.value)
        return JSON.stringify({ path: targetPath.inputPath, section: formatYamlPath(section.path), target: formatYamlPath(target.path), position: position.value, changed: true, truncated: false })
    }, async (targetPath, model, args) => {
        const sourceKey = validateEnvKey(args.section, "section", "resolve env section")
        if (!sourceKey.ok) return sourceKey.response
        const section = resolveEnvAssignment(model, sourceKey.value, "resolve env section", "Section")
        if (!section.ok) return section.response
        const position = normalizePosition(args.position)
        if (!position.ok) return position.response
        if (args.target === undefined) {
            const next = moveEnvAssignment(model, section.value, section.value, position.value)
            await adapter.write(targetPath, next)
            return JSON.stringify({ path: targetPath.inputPath, section: sourceKey.value, position: position.value, changed: true, truncated: false })
        }
        const targetKey = validateEnvKey(args.target, "target", "resolve env target")
        if (!targetKey.ok) return targetKey.response
        const targets = findEnvAssignments(model, targetKey.value)
        if (targets.length > 1) return duplicateEnvKeyResponse("resolve env target", targetKey.value, targets)
        const next = targetKey.value === sourceKey.value ? model.raw : targets.length === 1 ? moveEnvAssignment(model, section.value, targets[0], position.value) : renameEnvAssignment(model, section.value, targetKey.value)
        await adapter.write(targetPath, next)
        return JSON.stringify({ path: targetPath.inputPath, section: sourceKey.value, target: targetKey.value, position: position.value, changed: true, truncated: false })
    }, async (targetPath, model, args) => {
        const sourcePath = parseIniPath(args.section, model, "section", "resolve config section")
        if (!sourcePath.ok) return sourcePath.response
        const targetPathValue = parseIniPath(args.target, model, "target", "resolve config target")
        if (!targetPathValue.ok) return targetPathValue.response
        const section = resolveIniTarget(model, sourcePath.value, "resolve config section", "Section")
        if (!section.ok) return section.response
        const targetIniPath = section.value.section !== undefined && targetPathValue.value.section === undefined && targetPathValue.value.key !== undefined ? { section: targetPathValue.value.key } : targetPathValue.value
        if (section.value.section !== undefined && targetIniPath.section === section.value.section.name && targetIniPath.key !== undefined) return createRetryResponse("move config content", "Cannot move a section into its own key.", "Choose a target outside the moved section.")
        const targetAssignments = targetIniPath.key !== undefined ? findIniAssignments(model, targetIniPath) : []
        const targetSections = targetIniPath.key === undefined && targetIniPath.section !== undefined ? findIniSections(model, targetIniPath.section) : []
        if (targetAssignments.length > 1) return duplicateIniKeyResponse("resolve config target", targetIniPath, targetAssignments)
        if (targetSections.length > 1) return duplicateIniSectionResponse("resolve config target", targetIniPath.section ?? "", targetSections)
        const position = normalizePosition(args.position)
        if (!position.ok) return position.response
        const target = targetAssignments.length === 1 || targetSections.length === 1 ? resolveIniTarget(model, targetIniPath, "resolve config target", "Target") : undefined
        if (target !== undefined && !target.ok) return target.response
        const next = section.value.path === formatIniPath(targetIniPath) ? model.raw : target?.value !== undefined ? moveIniTarget(model, section.value, target.value, position.value) : renameIniTarget(model, section.value, targetIniPath)
        await adapter.write(targetPath, next)
        return JSON.stringify({ path: targetPath.inputPath, section: section.value.path, target: formatIniPath(targetIniPath), position: position.value, changed: true, truncated: false })
    }, async (targetPath, model, args) => {
        const sectionPath = parseTomlPath(args.section, "section", false, "resolve toml section")
        if (!sectionPath.ok) return sectionPath.response
        const targetPathValue = parseTomlPath(args.target, "target", false, "resolve toml target")
        if (!targetPathValue.ok) return targetPathValue.response
        const section = resolveTomlNode(model, sectionPath.value ?? [], "resolve toml section", "Section")
        if (!section.ok) return section.response
        const target = resolveTomlNode(model, targetPathValue.value ?? [], "resolve toml target", "Target")
        if (!target.ok) return target.response
        const position = normalizePosition(args.position)
        if (!position.ok) return position.response
        const next = moveTomlContent(model, section.value, target.value, position.value)
        if (!next.ok) return next.response
        await adapter.write(targetPath, next.value)
        return JSON.stringify({ path: targetPath.inputPath, section: formatTomlPath(section.value.path), target: formatTomlPath(target.value.path), position: position.value, changed: true, truncated: false })
    })
}

export function createContentRemoveHandler(adapter: ContentAdapter): ContentHandler<ToolArgs> {
    return createContentEditHandler(adapter, "remove content", async (target, model, args) => {
        const section = resolveSection(model, args.section)
        if (!section.ok) return section.response
        if (section.value.level === 1) return createRetryResponse("remove markdown content", "Cannot remove the H1 root.", "Remove a non-root section instead.")
        const body = `${model.body.slice(0, section.value.start)}${model.body.slice(section.value.end)}`
        await writeMarkdownBody(adapter, target, model, body)
        return JSON.stringify({ path: target.inputPath, section: section.value.path, changed: true, truncated: false })
    }, async (target, model, args) => {
        const sectionPath = parseJsonPath(args.section, "section", false)
        if (!sectionPath.ok) return sectionPath.response
        const section = resolveJsonNode(model, sectionPath.value ?? [])
        if (!section) return createRetryResponse("resolve json section", `Section not found: ${formatJsonPath(sectionPath.value ?? [])}`, "Retry with an existing JSON path.")
        if (section.path.length === 0) return createRetryResponse("remove json content", "Cannot remove the JSON document root.", "Remove a non-root node instead.")
        await adapter.write(target, applyJsonModify(model, section.path, undefined))
        return JSON.stringify({ path: target.inputPath, section: formatJsonPath(section.path), changed: true, truncated: false })
    }, async (target, model, args) => {
        const sizeError = validateYamlWriteSize(model, "remove yaml content")
        if (sizeError) return sizeError
        const sectionPath = parseYamlPath(args.section, "section", false)
        if (!sectionPath.ok) return sectionPath.response
        const section = resolveYamlNode(model, sectionPath.value ?? [])
        if (!section) return createRetryResponse("resolve yaml section", `Section not found: ${formatYamlPath(sectionPath.value ?? [])}`, "Retry with an existing YAML path.")
        const next = removeYamlContent(model, section)
        if (!next.ok) return next.response
        await adapter.write(target, next.value)
        return JSON.stringify({ path: target.inputPath, section: formatYamlPath(section.path), changed: true, truncated: false })
    }, async (target, model, args) => {
        const key = validateEnvKey(args.section, "section", "resolve env section")
        if (!key.ok) return key.response
        const section = resolveEnvAssignment(model, key.value, "resolve env section", "Section")
        if (!section.ok) return section.response
        await adapter.write(target, removeEnvAssignment(model, section.value))
        return JSON.stringify({ path: target.inputPath, section: section.value.key, changed: true, truncated: false })
    }, async (target, model, args) => {
        const sectionPath = parseIniPath(args.section, model, "section", "resolve config section")
        if (!sectionPath.ok) return sectionPath.response
        const section = resolveIniTarget(model, sectionPath.value, "resolve config section", "Section")
        if (!section.ok) return section.response
        await adapter.write(target, removeIniTarget(model, section.value))
        return JSON.stringify({ path: target.inputPath, section: section.value.path, changed: true, truncated: false })
    }, async (target, model, args) => {
        const sectionPath = parseTomlPath(args.section, "section", false, "resolve toml section")
        if (!sectionPath.ok) return sectionPath.response
        const section = resolveTomlNode(model, sectionPath.value ?? [], "resolve toml section", "Section")
        if (!section.ok) return section.response
        const next = removeTomlContent(model, section.value)
        if (!next.ok) return next.response
        await adapter.write(target, next.value)
        return JSON.stringify({ path: target.inputPath, section: formatTomlPath(section.value.path), changed: true, truncated: false })
    })
}

export function createFrontmatterReadHandler(adapter: ContentAdapter): ContentHandler<ToolArgs> {
    return async (args: ToolArgs): Promise<string> => {
        try {
            const target = await adapter.validateContentPath(args.path)
            if (!target.ok) return target.response
            if (target.value.mode === "json" || target.value.mode === "yaml" || target.value.mode === "env" || target.value.mode === "ini" || target.value.mode === "toml") return JSON.stringify({ path: target.value.inputPath, frontmatter: "", hasFrontmatter: false, truncated: false })
            const frontmatter = splitFrontmatter(await adapter.read(target.value))
            const content = truncateText(frontmatter.content)
            return JSON.stringify({ path: target.value.inputPath, frontmatter: content.value, hasFrontmatter: frontmatter.hasFrontmatter, truncated: content.truncated })
        }
        catch (error) {
            return createAbortResponse("read markdown frontmatter", toErrorMessage(error))
        }
    }
}

export function createFrontmatterWriteHandler(adapter: ContentAdapter): ContentHandler<ToolArgs> {
    return async (args: ToolArgs): Promise<string> => {
        try {
            if (typeof args.frontmatter !== "string") return createRetryResponse("write markdown frontmatter", "frontmatter must be a string.", "Retry with raw frontmatter as a string.")
            const target = await adapter.validateContentPath(args.path)
            if (!target.ok) return target.response
            if (target.value.mode === "json") return createRetryResponse("write frontmatter", "frontmatter is not supported for JSON/JSONC files.", "Use JSON content tools to edit JSON/JSONC files.")
            if (target.value.mode === "yaml") return createRetryResponse("write frontmatter", "frontmatter is not supported for YAML files.", "Use YAML content tools to edit YAML files.")
            if (target.value.mode === "toml") return createRetryResponse("write frontmatter", "frontmatter is not supported for TOML files.", "Use TOML content tools to edit TOML files.")
            if (target.value.mode === "env") return createRetryResponse("write frontmatter", "frontmatter only supported for Markdown files.", "Use content tools to edit .env files.")
            if (target.value.mode === "ini") return createRetryResponse("write frontmatter", "frontmatter only supported for Markdown files.", "Use content tools to edit config files.")
            const raw = await adapter.read(target.value)
            const frontmatter = splitFrontmatter(raw)
            const normalized = normalizeFrontmatter(args.frontmatter)
            const nextRaw = normalized.trim() === "" ? frontmatter.body : `---\n${normalized}\n---\n${frontmatter.body}`
            await adapter.write(target.value, nextRaw)
            return JSON.stringify({ path: target.value.inputPath, hasFrontmatter: normalized.trim() !== "", changed: true, truncated: false })
        }
        catch (error) {
            return createAbortResponse("write markdown frontmatter", toErrorMessage(error))
        }
    }
}

async function writeMarkdownBody(adapter: ContentAdapter, target: ContentTarget, model: MarkdownModel, body: string): Promise<void> {
    const raw = rebuild(model, body)
    parseMarkdown(raw)
    await adapter.write(target, raw)
}
