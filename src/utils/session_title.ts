const sessionTitleSuffixPattern = /\s+\(([^()]*)\)$/
const timestampSuffixPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
const agentSuffixes = new Set(["assist", "advise", "auto", "design"])

function isRecognizedSessionTitleSuffix(suffix: string): boolean {
    return agentSuffixes.has(suffix) || timestampSuffixPattern.test(suffix)
}

export function cleanSessionTitleSuffix(title: string): string {
    let cleanedTitle = title.trim()
    let match = cleanedTitle.match(sessionTitleSuffixPattern)

    while (match && isRecognizedSessionTitleSuffix(match[1])) {
        cleanedTitle = cleanedTitle.slice(0, match.index).trimEnd()
        match = cleanedTitle.match(sessionTitleSuffixPattern)
    }

    return cleanedTitle
}

export function formatSessionTitleForAgent(baseTitle: string, agent: string): string {
    const title = cleanSessionTitleSuffix(baseTitle)
    const agentSuffix = ` (${agent})`
    return title.endsWith(agentSuffix) ? title : `${title}${agentSuffix}`
}
