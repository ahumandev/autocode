import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"

const designPromptSource = readFileSync(new URL("./design.ts", import.meta.url), "utf8")

const requiredSaveContractRules = [
    "plan.md is the current source of truth during design, not only after proposal acceptance.",
    "Call \\`autocode_plan_save\\` immediately after any material change to PROBLEMS, IMPACT, EXPECTATIONS, REQUIREMENTS, CONSTRAINTS, RISKS, or PROPOSAL.",
    "If a scope change adds or drops REQUIREMENTS, save plan.md with the updated REQUIREMENTS; XML content support is future work/unsupported, while YAML/TOML/INI/properties/conf are in scope for content tools.",
    "Keep STEP 8 final accepted PROPOSAL save even when earlier design iterations were already saved.",
]
