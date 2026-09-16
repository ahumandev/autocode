export function newSessionTemplate(agent: string, promptInclusion: string, resumeInstruction: string): string {
    return `Hand off work to next agent.
1. Call \`autocode_session_context\` first to read sanitized recent messages and metadata.
2. Distill relevant recent context into a self-contained handoff prompt. Next agent has no visibility of this session.
3. Handoff \`prompt\` must include:
   - Known PROBLEM, IMPACT, EXPECTATION, REQUIREMENTS, RISKS, CONSTRAINTS, CRITERIA, GOALS, SUCCESS METRICS
   - All relevant facts like: paths, code/config/text samples to avoid wasteful rediscoveries
    - Unfinished work, blockers, and next actionable steps
   - ${promptInclusion}
   - Content of <resume_instruction> without wrapped tags:
<resume_instruction>
$ARGUMENTS

${resumeInstruction}
</resume_instruction>
4. Exclude noise like unimportant user discussions or unrelated verbose tool output. Redact secrets, tokens, credentials, and private keys.
5. Call \`autocode_session_create\` with agent="${agent}" and complete handoff prompt as \`prompt\`
6. Provide md link to new session in response for example:

\`\`\`md
Follow ${agent} session: [Title Of New Session](http://127.0.0.1:4096/abc/session/ses_1234)
\`\`\`
`
}
