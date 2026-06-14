import { buildNewSessionCommandTemplate } from "./new_session_template"

export const newResearchCommandTemplate = buildNewSessionCommandTemplate("research", `with instructions to research topic based on:
    - subject: name what info is required based on recent reasoning / user conversation
    - context: include all known facts related to instruction such as (past actions + its outcomes, failed attempts + reason for failure, constraints/opportunities discovered related to instruction)
    - proof: all known paths/links to sources of facts
    - data: previous tool output / research results / data provided by user (only include related to instruction; do not repeat already included data)`, "Follow research session")
