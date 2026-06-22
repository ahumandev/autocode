export const jobReviewCommitCommandTemplate = `
1. \`task\` subagent \`execute_git_commit\` with git commit message based on job plan and Review Report
2. Lastly when done, call \`autocode_job_shelve\` to shelve accepted review, then stop.
`
