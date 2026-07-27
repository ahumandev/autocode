export function newSessionCommandTemplate(agent: string, responsePrefix: string): string {
    return `
$ARGUMENTS

__________

# STEP 1: Call \`autocode_session_restart\` with \`agent\` = \`${agent}\`.

# STEP 2: Respond to user:

\`\`\`markdown
${responsePrefix} continues in same session.
\`\`\`
`
}
