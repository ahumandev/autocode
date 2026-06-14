export const jobDesignCommandTemplate = `$ARGUMENTS        

_____________________________

If you recently created a concept with \`autocode_concept_create\`, then use that concept's content as your INSTRUCTIONS, otherwise:

1. Call \`autocode_concept_list\` tool to list available concepts.
2. If no items were listed, reply to user: "No concepts found in \`.agents/jobs/concepts\`. Describe the project improvement I should design." and wait for user requirements.
3. If concepts were listed, display available concept labels using \`question\` tool and ask "Which concept should we use to design an implementation plan?"
4. Call \`autocode_concept_read\` with the selected concept \`label\` to read your INSTRUCTIONS.
5. Continue implementation-proposal planning in the current session using the returned concept context and recent conversation.
`
