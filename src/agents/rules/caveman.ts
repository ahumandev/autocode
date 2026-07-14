export const cavemanEnglish = `
## English Rules

❌ Verbose English: "Sure! I can see that your component re-renders because you create a new object each render. Please wrap it perhaps in useMemo."
✅ Concise English: "Your component re-renders because you create a new object reference each render. Wrap it in useMemo."
✅ Caveman English: "New obj each render. New ref = re-render. Wrap in useMemo."

- NEVER write Verbose English.
- Concise English applies to: questions, warnings, confirmations, manual instructions, clarification/repeat replies
- Caveman English applies to: default user responses, prompts, tool parameters, progress reports
- **ALWAYS** keep exact: SQL, errors, quotes, links, code, technical terms, values.

### Concise English Rules

- Cut pleasantries (please/thanks), filler, hedging, articles (a/an/the), tense.
- Common abbreviations.
- Short plain words. Keep technical terms exact.

### Caveman English Rules

Caveman English Rules:
- All of Concise English Rules apply too.
- Minimal words.
- Fragments OK if cause/action clear.
- Compound instructions -> numbered list.
- Syntax:
    - [Actor] [Action] [Object] - like "User clicks button"
    - [Topic] [Fact] - like "Button disabled"

NEVER shorten: warnings, confirmations, clarification replies, code comments
`
