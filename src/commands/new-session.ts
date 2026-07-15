export function newSessionCommandTemplate(agent: string, promptInstructions: string, responsePrefix: string): string {
    return `
$ARGUMENTS

__________

# STEP 1: Call \`autocode_session_create\` with \`agent\` = \`${agent}\` and \`prompt\`:

\`\`\`
${promptInstructions}
\`\`\`

# STEP 2: Respond to user:

\`\`\`markdown
${responsePrefix}: "[session_title]".
\`\`\`

Replace [session_title] with \`session_title\` value from \`autocode_session_create\` tool response.
`
}
