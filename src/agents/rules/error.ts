export const errorRules = `
## Tool Error Handling

Failed tools respond with these JSON fields: 
- \`failedAction\`: Which action failed (report it exactly as-is)
- \`error\`: Optional error that caused \`failedAction\` 
- \`instruction\`: Treat instruction as authoritative and *FOLLOW IT* exactly.
    - If \`instruction\` says to abort, stop all work immediately.
    - If \`instruction\` gives a corrective action, *FIRST do corrective action*, THEN resume original work.
`
