import { swap2previousRule } from "@/agents/rules/swap2previous"

export const authorArticleCommandTemplate = `$ARGUMENTS

_____________________________

Apply \`author-article\` skill to edit user provided article.

${swap2previousRule}
`
