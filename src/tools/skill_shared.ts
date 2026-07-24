export type ReferenceChange = {
    path: string
    description?: string
    deleted: boolean
}

const REFERENCES_SECTION_PATTERN = /\n?---\n## References\n[\s\S]*?(?=\n---\n|$)/

function parseExistingReferences(skillMdContent: string): Map<string, string> {
    const map = new Map<string, string>()
    const match = skillMdContent.match(REFERENCES_SECTION_PATTERN)
    if (!match) return map

    const section = match[0]
    const linkPattern = /^\*\s*\[(.*?)\]\((.*?)\)\s*$/gm
    let linkMatch = linkPattern.exec(section)
    while (linkMatch !== null) {
        const description = linkMatch[1]
        const refPath = linkMatch[2]
        map.set(refPath, description)
        linkMatch = linkPattern.exec(section)
    }

    return map
}

export function upsertReferencesSection(skillMdContent: string, changes: ReferenceChange[]): string {
    const map = parseExistingReferences(skillMdContent)

    for (const change of changes) {
        if (change.deleted) {
            map.delete(change.path)
        }
        else {
            map.set(change.path, change.description ?? "")
        }
    }

    const withoutSection = skillMdContent.replace(REFERENCES_SECTION_PATTERN, "").replace(/\s+$/, "\n")

    if (map.size === 0) {
        return withoutSection
    }

    const lines = ["---", "## References", "Call skill tool with `reference` arg set to one of these paths:"]
    for (const [refPath, description] of map) {
        lines.push(`* [${description}](${refPath})`)
    }

    const base = withoutSection.replace(/\n+$/, "\n")
    return `${base}\n${lines.join("\n")}\n`
}
