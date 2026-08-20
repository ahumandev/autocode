export const jobDraftCommandTemplate = `
1. Call \`autocode_design_write\` tool with design sections: PROBLEMS, IMPACT, EXPECTATIONS, REQUIREMENTS, CONSTRAINTS, and user chosen PROPOSAL.
2. Respond with:

\`\`\`markdown
Your design is saved at: \`[job_path]\`

Enter:
- \`/job-execute\` 🤖 to execute the planned job autonomously
- \`/job-facilitate\` 👨‍💻 to start assisted job execution
- \`/advise\` 🎓 to learn planned job execution
\`\`\`

Replace [job_path] with \`job_path\` value from \`autocode_design_write\` tool response.

# Plan Formatting Rules

- Never include H1, H2, or \`---\` separators in tool input.
- Requirements and constraints should use H3 subsections.
- Each requirement should include bullet point CRITERIA in its subsection body.
- Keep user examples and quoted evidence intact.
- Use emojis only to highlight important points.
- Include markdown links to sources consulted.
- Record known uncertainty and limitations in constraints, required validation in requirements, and mitigation in proposal.
`
