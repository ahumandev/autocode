import { buildNewSessionCommandTemplate } from "./new_session_template"

export const newAssistCommandTemplate = buildNewSessionCommandTemplate("assist", `with recent user instructions to solve recently mentioned problem which includes:
    - PROBLEMS = Brief background context and wrong/missing behavior/info (undesired symptoms)
    - REQUIREMENTS = Expected system behavior / use case / answer to query
    - CONSTRAINTS = research scope (domain) or fixed technical/legal limits (facts) like security measures, dependencies, performance limitations, maintainability limitations, failure handling, reversibility, etc.
    - RISKS = any uncertainties (inaccessible/conflicting info), *assumed* limitations (edge-case concerns), external blockers (uncontrollable events/dependencies preventing solution), assumed caused of problem
    - PROPOSAL = only include if user suggested a solution
    - DATA = proof (all known paths/links to sources or facts), previous tool output, research results, exact values provided by user (do not repeat already included data)`, "Assist task execution session")
