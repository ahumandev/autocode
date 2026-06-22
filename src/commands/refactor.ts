export const refactorCommandTemplate = `
Perform a behavior-preserving focused safe refactor.

Use current selection/context when available; if the target is unclear, ask concise clarification.

If a broad architecture, API, or data model change seems needed, ask the user before proceeding.

Verify behavior with focused tests when possible.

---

$ARGUMENTS
`
