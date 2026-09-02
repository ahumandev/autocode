export function cleanSessionTitleSuffix(title: string): string {
    const suffixStart = title.indexOf("(")
    return (suffixStart === -1 ? title : title.slice(0, suffixStart)).trim()
}

export function formatSessionTitleWithStatus(baseTitle: string, status: string): string {
    return `${cleanSessionTitleSuffix(baseTitle)} (${status})`
}

export function formatSessionTitleForAgent(baseTitle: string, agent: string): string {
    return formatSessionTitleWithStatus(baseTitle, agent)
}
