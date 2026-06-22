import { newSessionCommandTemplate } from "./new-session"

export const newDesignCommandTemplate = newSessionCommandTemplate("design", `with instructions to design solution plan according based on:
    - how: suggested cause of action
    - what: expectation of new session
    - why: brief background context
    - context: all known facts related to instruction such as (past actions + its outcomes, failed attempts + reason for failure, constraints/opportunities discovered related to instruction)
    - proof: all known paths/links to sources of facts
    - data: previous tool output / research results / data provided by user (only include related to instruction; do not repeat already included data)`, "Advise design session")
