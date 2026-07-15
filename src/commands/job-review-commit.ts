export const jobReviewCommitCommandTemplate = `
1. Use \`git-commit\` skill to create Git commit message based on job plan and Review Report.
2. Commit git message.
3. Only if git tool fails: Tell user exact Git commit message wrapped in md block.
4. Lastly when done, call \`autocode_job_shelve\` to shelve accepted review, then stop.
`
