export function newSessionTemplate(agent: string, promptInclusion: string, resumeInstruction: string): string {
    return `You handoff work to next agent with \`autocode_session_create\`.
Next agent prompt:
- YOUR responsibility to define PROBLEM, IMPACT, EXPECTATION, REQUIREMENTS (including CRITERIA), RISKS, CONSTRAINTS (from already known info) to next agent in prompt.
- Next agent has no visibility of this session.
- Prompt must be thorough but exclude unnecessary noise.
- Include all relevant facts, paths, code/config/text samples to avoid wasteful rediscoveries but next agent.
- ${promptInclusion}
- also add to prompt content of <resume_instruction> for next agent:
<resume_instruction>
$ARGUMENTS

${resumeInstruction}
</resume_instruction>

1. Call \`autocode_session_create\` with agent="${agent}" and complete prompt as defined above.
2. Provide md link to new session in response for example:

\`\`\`md
Follow ${agent} session: [Title Of New Session](http://127.0.0.1:4096/abc/session/ses_1234)
\`\`\`
`
}
