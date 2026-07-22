export const gitCommitCommandTemplate = `
GOAL: Execute commit now.

Reason for recent change:

\`\`\`\`\`md
$ARGUMENTS
\`\`\`\`\`

1. Then fast commit using ONLY known info without git queries tasks or \`bash\` commands.
2. Otherwise, reason and changes completely unknown? Only then task subagents to discover recent file changes (last resort)
3. Use git tools to add all related files to "Reason for recent change" or add all files from "discover recent file changes".
4. Use \`git-commit\` skill to Create Git Commit message based on SOLUTION + Reason.
5. Commit with \`git_commit\` tool - NEVER any other tool
6. Only if git tools fails: Tell user exact Git commit message wrapped in md block.
`
