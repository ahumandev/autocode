export const jobReviewCommandTemplate = `
1. Call \`autocode_criteria_list\` tool, if output show any unmet criteria, then inform user about unmet criteria and stop.
2. If this is git repo, then base your git commit message on plan of this job and Review Report.
3. Lastly when done, call \`autocode_job_shelve\` to shelve accepted review, then stop.
`
