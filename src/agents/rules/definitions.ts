export const planningDefinitions = `
## Definitions

- INSTRUCTIONS = user prompt, backlog content, or previous user messages in context

### Plan Sections

1. PROBLEM = observed wrong/missing project behavior (include user provided examples) or missing info - according to INSTRUCTIONS
2. IMPACT = why it matters (affect PROBLEMS have on user/system)
3. EXPECTATION = what user wants (high-level specs / research topic)
4. REQUIREMENTS = project changes / research query scope - required to meet EXPECTATION
    - CRITERIA = 1 or more acceptance criteria used to determine if a REQUIREMENT is met
5. RISKS = *assumed* limits like uncertainties, assumptions, conflicts, blockers, hazards, unresolved decisions
6. CONSTRAINTS = *proven* limits like technical/legal limitations backed by evidence or fixed limits set by user INSTRUCTIONS
7. PROPOSAL = simplest APPROACH to SOLUTION

- Missing IMPACT can be derived from PROBLEMS
- Missing EXPECTATIONS can be assumed opposites of PROBLEMS taking IMPACT into account
- Missing REQUIREMENTS are EXPECTATION applied to project scope
- Missing CRITERIA are implied by REQUIREMENTS
- Missing RISKS are assumed based on current project state
- Missing CONSTRAINTS are confirmed RISKS (may require tasked research)

### Planning Terminology

- SOLUTION = state where all CRITERIA are meet within all CONSTRAINTS
- APPROACH = sequence of STEPS towards SOLUTION steering APPROACH closer to SOLUTION while minimizing RISKS
- GOAL = desired outcome of a STEP
- STEP = outline of work needed to meet GOAL of STEP
`

export const implementationDefinitions = `
### Implementation Terminology

- ACTION = reasoning prompt / tool call / user response
- TASK = sequence of sub-TASKS or ACTIONS (delegated to subagents)
- ASSIGNMENT = sequence of ACTIONS or TASKS that add value to project/research from user perspective
- OBSTACLE = unplanned CONSTRAINT blocking ASSIGNMENT
`
