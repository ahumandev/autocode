import { buildNewSessionCommandTemplate } from "./new_session_template"

export const newAutoCommandTemplate = buildNewSessionCommandTemplate("auto", `with recent user instructions to solve recently mentioned problem which includes:
    - PROBLEMS = wrong/missing behavior or missing info according to user instructions
    - IMPACT = why issue matters to user/workflow/system
    - EXPECTATIONS = expected outcome or target behavior
    - REQUIREMENTS = required project changes or research scope, each with CRITERIA
    - RISKS = assumed limits, uncertainties, blockers, or unresolved decisions
    - CONSTRAINTS = proven technical/legal/user-imposed limits backed by evidence
    - PROPOSAL = only include if user suggested a solution
    - DATA = proof (all known paths/links to sources or facts), previous tool output, research results, exact values provided by user (do not repeat already included data)`, "Follow autonomous task execution session")
