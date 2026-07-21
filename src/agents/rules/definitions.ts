export const planningDefinitions = `
## Definitions

- INSTRUCTIONS = user prompt, backlog content, or previous user messages in context

### Plan Sections

1. PROBLEM = wrong/missing project behavior (including examples) or missing info <- according to INSTRUCTIONS
2. IMPACT = *why* PROBLEM matters to project users / integrated systems
3. EXPECTATION = *what* user wants (high-level specs / research topic) <- from project owner perspective
4. REQUIREMENTS = project changes / research query scope <- from developer perspective
    - CRITERIA = 1 or more acceptance criteria used to determine if a REQUIREMENT is met
5. RISKS = *assumed* limits like uncertainties, assumptions, conflicts, hazards, unresolved decisions
6. CONSTRAINTS = *confirmed* limits like technical/legal limitations backed by evidence or fixed limits set by user INSTRUCTIONS
7. PROPOSAL = selected APPROACH to SOLUTION

- Derive missing EXPECTATIONS from opposites of PROBLEMS taking IMPACT into account.
- Likewise derive any other missing info from known plan sections.

### Planning Terminology

1. SOLUTION = final state where all CRITERIA are meet within all CONSTRAINTS
2. APPROACH = roadmap of achievable GOALS steering towards SOLUTION including technical key hints (how)
3. GOAL = measurable desired outcome adding minimum value to INSTRUCTIONS
4. STEP = list what GOAL needs: info/resources/changes
`

export const implementationDefinitions = `
${planningDefinitions}

### Implementation Terminology

5. ASSIGNMENT = workflow of high-level TASKS to solve STEP needs
6. TASK = sequence of practical ACTIONS to meet 1 ASSIGNMENT (delegated to subagents)
7. ACTION = skill load / tool call / reasoning step / user question or feedback

OBSTACLE = unplanned CONSTRAINT or confirmed RISK discovered blocking ASSIGNMENT
`
