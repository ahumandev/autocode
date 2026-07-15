export const gitCommitCommandTemplate = `
Reason for recent change:

\`\`\`\`\`md
$ARGUMENTS
\`\`\`\`\`

❌ NEVER call \`bash\` nor shell nor use any other tool to to query git status.

1. Changes or reason for commit known? Then use known info ONLY, skip ALL git queries tasks, skip \`bash\` commands.
2. Otherwise, reason and changes completely unknown? Only then task subagents to discover recent file changes (last resort)
3. Use \`git-commit\` skill to Create Git Commit message based on SOLUTION + Reason.
4. Commit with \`git_commit\` tool - NEVER any other tool
5. Only if git tool fails: Tell user exact Git commit message wrapped in md block. 
`
