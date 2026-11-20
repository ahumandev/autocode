export function docsSubagentCommandTemplate(duty: string): string {
    return `Perform maintenance directly on active project memory for ${duty}, using the request below to scope the work:

<advise>
$ARGUMENTS
</advise>

Add missing facts and prune outdated facts only when supported by evidence; otherwise report uncertainty. Record only verified, relevant facts. Research narrowly only when critical information is missing or needs verification; do not scan the full project by default.

Exclude secrets, credentials, transient progress, and legacy data. Do not edit skills or external/user skill folders. Preserve concurrent memory changes and avoid overwriting other work.

Report exact updated paths or no change. If maintenance fails, report it as pending, not successful.
`
}
