export function restartSessionTemplate(agent: string, prompt: string): string {
    return `
$ARGUMENTS

__________

1. First call \`autocode_session_restart\` with \`agent\` = \`${agent}\`.
2. Then: ${prompt}
`
}
