import { markdown } from "@/agents/rules/markdown"

export const reportCommandTemplate = `

Unless user specified report format, respond to user with this report template:

\`\`\`markdown

[GOAL]

[ACTIONS]

[CONSTRAINTS]

[CAUSE]

[DISCOVERIES]

[CHANGES]

[RESULTS]

[SHORTCOMING]

[REVIEW]

\`\`\`

In the above <report> template replace the \`[PLACEHODERS]\` with following sections:

- Replace [GOAL] with section that has:
    - An H2 title that summarize overall goal:
    - Content summarize problem being address in 1 sentence (max 20 words)
    - Bullet point list of requirements to meet goal without repeating yourself (max 40 words per requirement)
- Replace [ACTIONS] with section that has:
    - An H2 title that summarize overall action taken so far and include section that:
    - If < 10 project actions, then list project actions individually, otherwise group project actions up to 10 groups of project actions where each numbered list item:
        - Project actions exclude internal task management actions like "Update job status", "Add/Set criteria", "Report results to user" - NEVER report internal task management actions
        - Describe action item (20 words max)
        - Inline critical command/url/values used by group of actions
        - Reason why action item were taken (20 words max)
- Replace [CONSTRAINTS] with section that has:
    - An H2 title that summarize overall constraints and include subsections which each:
        - Subsection title summarize 1 key constraint discovery
        - Subsection content explain: what constraints were found (how it limits solution approaches)
        - Include formatted sample code, diagrams, tables and quotes if applicable
        - Include path/link to source of every constraint
    - Omit [CONSTRAINTS] section if there are no constraints to report
- Replace [CAUSE] with section that has:
    - An H2 title that summarize cause of problem
    - Content explain: what caused problem mentioned in [GOAL]
    - Formatted sample code, diagrams, tables and quotes if applicable
    - Paths/links to sources of every constraint
    - Omit [CAUSE] section if not relevant
- Replace [EVIDENCE] with section that has:
    - An H2 title that summarize what research had proven and include subsections which each:
        - Subsection title summarize key fact that contributed to research conclusion
        - Subsection content include formatted sample code, diagrams, tables and quotes from source that proof key fact
        - Include path/link to source of discovery (public websites as markdown links in text)
        - Summarize what was learned in max 40 words (if not obvious from evidence)
    - Omit [EVIDENCE] section if [GOAL] was not research or if no evidence was discovered
- Replace [CHANGES] with section that has:
    - An H2 title that summarize overall change and include subsections which each:
        - Subsection title summarize 1 key behavioural change
        - Subsection content describe what had changed (old vs new behaviour)
        - If not already mentioned by above [ACTIONS], explain why the behaviour changed (if not obvious)
        - Include formatted sample code/config/input/output changes
        - If change is a breaking change (to third-party clients/users), highlight impact breaking change may have on them
    - NEVER include test updates as "changes"
    - Omit [CHANGES] section if there are no changes to report
- Replace [RESULTS] with section that has:
    - An H2 title that summarize the outcome
    - Section content directly address above [GOAL] section: Answer question / provide research conclusion / summarize cause/solution to problem
    - May contain sub-sections
    - Include any charts, graphs, or tables, examples, inline markdown images referencing public online sources if needed
    - Does not repeat any info already reported in above sections
- Replace [SHORTCOMING] with section that has:
    - An H2 title that summarize current shortcoming status of project
    - Only include [SHORTCOMING] section if requirements in [GOAL] was not meet or critical aspects of research topic is unclear.
    - For each shortcoming include subsection with:
        - Subsection title summarizing shortcoming
        - Subsection content that info gap or wrong project behaviour that still needs to be addressed (20 words max)
        - Also include reason why shortcoming exist (80 words max) if there are no solution yet / gap in info (more research/design required)
            - never explain known but incomplete solutions/tasks agent did not attempt yet because reason is obvious
- Replace [REVIEW] with section that has:
    - An H2 title that summarize how to review
    - Section content that guide user to review changes as numbered steps, where each review step subsection has:
        - Subsection title describing required action
        - Each step is subsection explaining why step is necessary and exact instructions to complete step
        - Each step title start with relevant emoji followed by summary of step action (10 words max)
        - Include formatted sample input/output in step subsections
        - Include warnings about common pitfalls
    - Only include [REVIEW] section if there were verifiable changes made to project from user perspective
    - NEVER include [REVIEW] section that lead to "read this file content" or "compare these files" as that will be verified by pull requests

Rules:
- Every heading title must be < 10 words
- Every section or subsection must be < 80 words
- Every bullet point must be < 40 words
- Start H2 titles and bullet points with relevant emojis
${markdown}
`