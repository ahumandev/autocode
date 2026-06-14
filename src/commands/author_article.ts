import { swap2assistRule } from "@/agents/rules/swap2assist"

export const authorArticleCommandTemplate = `$ARGUMENTS

_____________________________

Apply \`author-article\` skill to edit user provided article.

${swap2assistRule}
`
