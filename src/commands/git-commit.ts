import { swap2previousRule } from "@/agents/rules/swap2previous"

export const gitCommitCommandTemplate = `
Base your git commit message on the following:
  - Purpose of this session (see title)
  - Your recent conversation with user
  - Recent changes

${swap2previousRule}
`
