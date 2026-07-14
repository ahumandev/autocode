export const jobConceptsCommandTemplate = `$ARGUMENTS

CONCEPT = a conceptual project improvement idea (like fixing bug, adding feature, optimizing processes)

1. Group CONCEPTS according to relevancy (related CONCEPTS grouped together), independent CONCEPTS separate groups
2. Create 1 CONCEPT per independent group of issues calling \`autocode_concept_create\` tool with formatted [Concept Parameter](#concept)
3. Report CONCEPT labels and file paths.

## Concept Parameter {concept}

- Should be concise (without unnecessary opinions, commentary, politeness, noise) but written in complete human readable sentences.
- Include all known links, facts, examples, quotes, ideas, feasibility notes, and explanations about the problem(s).
- Attention with emojis
- Apply \`author-article\` skill.
`
