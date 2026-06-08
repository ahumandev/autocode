const leadingYamlFrontMatterPattern = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n\r?\n|\r?\n)?/

export function stripLeadingYamlFrontMatter(source: string): string {
    return source.replace(leadingYamlFrontMatterPattern, "")
}

export function getMarkdownBody(markdown: string): string {
    return stripLeadingYamlFrontMatter(markdown).trim()
}
