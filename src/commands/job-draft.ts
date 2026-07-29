export const jobDraftCommandTemplate = `
1. Call \`autocode_job_draft\` tool with planned sections: PROBLEMS, IMPACT, EXPECTATIONS, REQUIREMENTS, RISKS, CONSTRAINTS, and user chosen PROPOSAL.
2. Respond with:

\`\`\`markdown
Your plan is saved at: \`[job_path]\`

Enter:
- \`/job-execute\` 🤖 to execute the planned job autonomously
- \`/job-facilitate\` 👨‍💻 to facilitate planned job execution
- \`/job-teach\` 🎓 to learn planned job execution
\`\`\`

Replace [job_path] with \`job_path\` value from \`autocode_job_draft\` tool response.

# Plan Formatting Rules

- Never include H1, H2, or \`---\` separators in tool input.
- Requirements, risks, and constraints should use H3 subsections.
- Each requirement should include bullet point CRITERIA in its subsection body.
- Keep user examples and quoted evidence intact.
- Use emojis only to highlight important points.
- Include markdown links to sources consulted.
- Every constraints must be backed by evidence, assumptions are risks.
`
