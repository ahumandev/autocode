import { swap2assistRule } from "@/agents/rules/swap2assist"

export const gitCommitCommandTemplate = `
Base your git commit message on the following:
  - Purpose of this session (see title)
  - Your recent conversation with user
  - Recent changes

${swap2assistRule}
`
