export type CanonicalStatusChecker = (value: string) => boolean

const sessionTitleSuffixPattern = /\s+\(([^()]*)\)$/
const timestampSuffixPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

function isRecognizedSessionTitleSuffix(suffix: string, isCanonicalStatus: CanonicalStatusChecker): boolean {
    return isCanonicalStatus(suffix) || timestampSuffixPattern.test(suffix)
}

export function cleanSessionTitleSuffix(title: string, isCanonicalStatus: CanonicalStatusChecker): string {
    let cleanedTitle = title.trim()
    let match = cleanedTitle.match(sessionTitleSuffixPattern)

    while (match && isRecognizedSessionTitleSuffix(match[1], isCanonicalStatus)) {
        cleanedTitle = cleanedTitle.slice(0, match.index).trimEnd()
        match = cleanedTitle.match(sessionTitleSuffixPattern)
    }

    return cleanedTitle
}

export function formatSessionTitleForAgent(baseTitle: string, agent: string, isCanonicalStatus: CanonicalStatusChecker): string {
    const title = cleanSessionTitleSuffix(baseTitle, isCanonicalStatus)
    const agentSuffix = ` (${agent})`
    return title.endsWith(agentSuffix) ? title : `${title}${agentSuffix}`
}

export function formatSessionTitleForJobStatus(baseTitle: string, agent: string, status: string | undefined, isCanonicalStatus: CanonicalStatusChecker): string {
    const title = cleanSessionTitleSuffix(baseTitle, isCanonicalStatus)
    return agent === "auto" && status !== undefined && isCanonicalStatus(status) ? `${title} (${status})` : title
}
