import type { AgentConfig } from "@opencode-ai/sdk/v2"
import type { ExternalDirectoryRules, ModelTier, PermissionAction } from "@/config"
import { assistBrowserPrompt } from "./prompts/assist_browser";
import { assistGitConflictPrompt } from "./prompts/assist_git_conflict";
import { assistPrompt } from "./prompts/assist";
import { assistTroubleshootPrompt } from "./prompts/assist_troubleshoot";
import { autoDesignPrompt } from "./prompts/auto_design";
import { autoFeaturePrompt } from "./prompts/auto_feature";
import { autoGeneralPrompt } from "./prompts/auto_general";
import { autoPrompt } from "./prompts/auto"
import { buildRefactorPrompt } from "./prompts/auto_refactor";
import { buildResearchPrompt } from "./prompts/auto_research";
import { buildReviewApiPrompt } from "./prompts/auto_review_api";
import { buildReviewUiPrompt } from "./prompts/auto_review_ui";
import { buildTestPrompt } from "./prompts/auto_test";
import { buildTroubleshootPrompt } from "./prompts/auto_troubleshoot";
import { designPrompt } from "./prompts/design";
import { documentAgentsPrompt } from "./prompts/document_agents"
import { documentCodePrompt } from "./prompts/document_code"
import { documentConventionsPrompt } from "./prompts/document_conventions"
import { documentInstallPrompt } from "./prompts/document_install"
import { documentPrdPrompt } from "./prompts/document_prd"
import { documentUxPrompt } from "./prompts/document_ux"
import { executeAuthorPrompt } from "./prompts/execute_author";
import { executeCodePrompt } from "./prompts/execute_code";
import { executeDebugPrompt } from "./prompts/execute_debug";
import { executeDocumentPrompt } from "./prompts/execute_document"
import { executeExcelPrompt } from "./prompts/execute_excel";
import { executeGitCommitPrompt } from "./prompts/execute_git_commit";
import { executeOsPrompt } from "./prompts/execute_os";
import { executeOpencodePrompt } from "./prompts/execute_opencode";
import { executeRestPrompt } from "./prompts/execute_rest";
import { executeScriptPrompt } from "./prompts/execute_script";
import { isSandboxPlatformSupported, type SandboxPlatformSupportOptions } from "@/utils/sandbox"
import { queryArchitectPrompt } from "./prompts/query_architect";
import { queryAutocodePrompt } from "./prompts/query-autocode";
import { queryBrowserPrompt } from "./prompts/query_browser";
import { queryCodePrompt } from "./prompts/query_code";
import { queryDbPrompt } from "./prompts/query_db";
import { queryExcelPrompt } from "./prompts/query_excel";
import { queryGitPrompt } from "./prompts/query_git";
import { queryOsPrompt } from "./prompts/query_os";
import { queryTextPrompt } from "./prompts/query_text";
import { queryWebPrompt } from "./prompts/query_web";
import { researchPrompt } from "./prompts/research";
import { tempConceptPrompt } from "./prompts/temp_concept";
import { tempManualPrompt } from "./prompts/temp_manual";
import { tempReportPrompt } from "@/agents/prompts/temp_report";
import { documentEnvPrompt } from "./prompts/document_env";
import { querySshPrompt } from "./prompts/query_ssh";
import { executeSshPrompt } from "./prompts/execute_ssh";
import { executeConfigPrompt } from "./prompts/execute_config";

type PermissionTargetRules = Record<string, PermissionAction>
type AutocodePermissionRule = PermissionAction | PermissionTargetRules
type AutocodeTaskPermissionRules = Record<string, AutocodePermissionRule>
type AutocodePermissionObject = {
    task?: PermissionAction | AutocodeTaskPermissionRules
    [key: string]: AutocodePermissionRule | AutocodeTaskPermissionRules | undefined
}
export type AutocodeAgentConfig = Omit<AgentConfig, "permission"> & { permission?: PermissionAction | AutocodePermissionObject, tier?: ModelTier }
type AgentConfigWithTier = AutocodeAgentConfig
type AgentMap = Record<string, AgentConfigWithTier>
type PermissionObject = AutocodePermissionObject
type SandboxPlatformPolicyOptions = NodeJS.Platform | SandboxPlatformSupportOptions

const sandboxToolPermissionKeys = ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy"] as const

function hasAskCapableQuestionPermission(permission: AutocodeAgentConfig["permission"]): boolean {
    if (!permission || typeof permission === "string") {
        return false
    }

    return permission.question === "ask" || permission.question === "allow"
}

const sandboxCopyTargetPermission: PermissionTargetRules = {
    sandbox_target: "allow",
    local_target: "allow",
}

function isPermissionAction(action: unknown): action is PermissionAction {
    return action === "allow" || action === "ask" || action === "deny"
}

function normalizePermissionAction(action: PermissionAction, canAsk: boolean): PermissionAction {
    if (action === "ask" && !canAsk) {
        return "deny"
    }

    return action
}

function createExternalPermissionRules(source: unknown, canAsk: boolean): Record<string, PermissionAction> {
    if (isPermissionAction(source)) {
        return { "*": normalizePermissionAction(source, canAsk) }
    }

    if (!source || typeof source === "string") {
        return { "*": "deny" }
    }

    const rules: Record<string, PermissionAction> = {}
    for (const [pattern, action] of Object.entries(source as Record<string, unknown>)) {
        if (isPermissionAction(action)) {
            rules[pattern] = normalizePermissionAction(action, canAsk)
        }
    }

    if (!hasPermissionRule(rules, "*")) {
        rules["*"] = "deny"
    }

    return rules
}

function applyExternalDirectoryOverrides(
    rules: Record<string, PermissionAction>,
    externalDirectories: ExternalDirectoryRules,
    canAsk: boolean,
): Record<string, PermissionAction> {
    return {
        ...rules,
        ...Object.fromEntries(Object.entries(externalDirectories).map(([pattern, action]) => [
            pattern,
            normalizePermissionAction(action, canAsk),
        ])),
    }
}

function hasPermissionRule(permission: PermissionObject, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(permission, key)
}

function hasSandboxPermissionRule(permission: PermissionObject): boolean {
    return sandboxToolPermissionKeys.some((key) => hasPermissionRule(permission, key))
        || Object.entries(permission).some(([key, action]) => isPermissionAction(action)
            && action !== "deny"
            && sandboxToolPermissionKeys.some((toolKey) => matchesPermissionWildcard(key, toolKey)))
}

function matchesPermissionWildcard(pattern: string, key: string): boolean {
    if (!pattern.includes("*")) {
        return false
    }

    const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
    return new RegExp(`^${escapedPattern}$`).test(key)
}

export function applyExternalDirectoryPolicy(
    agents: AgentMap,
    externalDirectories: ExternalDirectoryRules = {},
): AgentMap {
    return Object.fromEntries(Object.entries(agents).map(([agentName, agent]) => {
        if (!agent.permission || typeof agent.permission === "string") {
            return [agentName, agent]
        }

        const canAsk = hasAskCapableQuestionPermission(agent.permission)
        const permission: PermissionObject = { ...agent.permission }
        const externalDirectorySource = hasPermissionRule(permission, "external_directory")
            ? permission.external_directory
            : permission.task_external
        const hadTaskExternal = hasPermissionRule(permission, "task_external")

        permission.external_directory = applyExternalDirectoryOverrides(
            createExternalPermissionRules(externalDirectorySource, canAsk),
            externalDirectories,
            canAsk,
        )

        if (hadTaskExternal) {
            permission.task_external = applyExternalDirectoryOverrides(
                createExternalPermissionRules(permission.task_external, canAsk),
                externalDirectories,
                canAsk,
            )
        }

        return [agentName, { ...agent, permission }]
    }))
}

export function applySandboxPlatformPolicy(agents: AgentMap, options: SandboxPlatformPolicyOptions = {}): AgentMap {
    if (isSandboxPlatformSupported(normalizeSandboxPlatformPolicyOptions(options))) return agents

    return Object.fromEntries(Object.entries(agents).map(([agentName, agent]) => {
        const agentWithDisable = agentName === "execute_sandbox" ? { ...agent, disable: true } : agent
        if (!agentWithDisable.permission) {
            return [agentName, agentWithDisable]
        }

        if (typeof agentWithDisable.permission === "string") {
            if (!isPermissionAction(agentWithDisable.permission) || agentWithDisable.permission === "deny") return [agentName, agentWithDisable]
            return [agentName, { ...agentWithDisable, permission: createSandboxDeniedPermission({ "*": agentWithDisable.permission }) }]
        }

        const permission: PermissionObject = { ...agentWithDisable.permission }
        const exposesSandboxTools = hasSandboxPermissionRule(permission)
        if (!exposesSandboxTools) return [agentName, agentWithDisable]

        return [agentName, { ...agentWithDisable, permission: createSandboxDeniedPermission(permission) }]
    }))
}

function normalizeSandboxPlatformPolicyOptions(options: SandboxPlatformPolicyOptions): SandboxPlatformSupportOptions {
    return typeof options === "string" ? { platform: options } : options
}

function createSandboxDeniedPermission(permission: PermissionObject): PermissionObject {
    for (const key of sandboxToolPermissionKeys) {
        permission[key] = "deny"
    }

    return permission
}

function applyBundledAgentPolicy(
    agents: AgentMap,
    externalDirectories: ExternalDirectoryRules,
    sandboxSupportOverride?: SandboxPlatformSupportOptions,
): AgentMap {
    return applySandboxPlatformPolicy(
        applyExternalDirectoryPolicy(agents, externalDirectories),
        sandboxSupportOverride ?? {},
    )
}

const colorAutonomousOrchestrator = "#AA0000"
const colorWritableInteractiveOrchestrator = "#00AA00"
const colorReadOnlyInteractiveOrchestrator = "#0000AA"
const colorWritableWorker = "#AA8300"
const colorReadOnlyWorker = "#00AAAA"
const colorDocumentWorker = "#AA00AA"

const baseAgents: AgentMap = {

    // Build-in opencode

    build: {
        disable: true,
    },

    compaction: {
        tier: "cheap",
    },

    explore: {
        disable: true,
    },

    general: {
        disable: true,
    },

    plan: {
        disable: true,
    },

    // Primary Orchestrators

    assist: {
        color: colorWritableInteractiveOrchestrator,
        description: "Assist with task executions.",
        hidden: false,
        mode: "primary",
        permission: {
            "*": "deny",
            autocode_agent_swap: "allow",
            autocode_dependencies: "allow",
            autocode_job_status: "allow",
            autocode_sandbox_create: "ask",
            autocode_sandbox_delete: "allow",
            edit: "allow",
            question: "allow",
            "skill_learn_*": "allow",
            task: {
                "*": "allow",
                "auto*": "deny",
                build: "deny",
                "document*": "deny",
                plan: "deny",
                "temp*": "deny"
            },
            task_external: "ask",
            task_resume: "allow",
            "todo*": "allow"
        },
        prompt: assistPrompt,
        tier: "balanced",
    },

    auto: {
        color: colorAutonomousOrchestrator,
        description: "Autonomously execute tasks.",
        hidden: false,
        mode: "primary",
        permission: {
            "*": "deny",
            autocode_agent_swap: "allow",
            autocode_job_status: "allow",
            doom_loop: "ask",
            "skill_learn_*": "allow",
            task: {
                "*": "deny",
                "auto_*": "allow",
                query_skills: "allow"
            },
            task_resume: "allow",
            "todo*": "allow",
        },
        prompt: autoPrompt,
        temperature: 0.4,
        tier: "smart",
    },

    design: {
        color: colorReadOnlyInteractiveOrchestrator,
        description: "Design implementation proposals from recent conversation and Research Report data.",
        hidden: false,
        mode: "primary",
        permission: {
            "*": "deny",
            autocode_agent_execute: "allow",
            autocode_concept_list: "allow",
            autocode_concept_read: "allow",
            autocode_job_execute: "allow",
            autocode_plan_save: "allow",
            autocode_session_create: "allow",
            doom_loop: "ask",
            external_directory: "ask",
            question: "allow",
            "skill_learn_*": "allow",
            task: {
                "*": "deny",
                "query*": "allow",
            },
            task_external: "ask",
            task_resume: "allow",
            "todo*": "allow",
        },
        prompt: designPrompt,
        temperature: 0.7,
        tier: "smart",
    },

    research: {
        color: colorReadOnlyInteractiveOrchestrator,
        description: "Research a topic and produce a Research Report.",
        hidden: false,
        mode: "primary",
        permission: {
            "*": "deny",
            autocode_agent_swap: "allow",
            doom_loop: "ask",
            external_directory: "ask",
            question: "allow",
            task: {
                "*": "deny",
                "query*": "allow",
            },
            task_external: "ask",
            task_resume: "allow",
            "todo*": "allow",
        },
        prompt: researchPrompt,
        temperature: 0.7,
        tier: "smart",
    },

    // Secondary Orchestrators

    assist_browser: {
        color: colorWritableInteractiveOrchestrator,
        description: "Task `assist_browser` for interactive browser automation: Browser access that can fill forms, submit, save, upload, and pair with user for manual steps like login, captcha, and 2FA. Browser state persists across calls via `task_id` so the tab and login session are not re-discovered.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "chrome*": "allow",
            doom_loop: "deny",
            question: "allow",
            skill: {
                "*": "deny",
                "execute-ux": "allow",
            },
            "todo*": "allow",
        },
        prompt: assistBrowserPrompt,
        temperature: 0.3,
        tier: "balanced",
    },

    assist_git_conflict: {
        color: colorWritableInteractiveOrchestrator,
        description: "Task `assist_git_conflict` to resolve git merge conflicts",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "deny",
            edit: "allow",
            git_add: "allow",
            git_log: "allow",
            git_status: "allow",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            question: "allow",
            read: "allow",
            skill: {
                "*": "ask",
                "code*": "allow",
                "execute*": "allow",
            },
            task: {
                "*": "deny",
                execute_code: "allow",
                execute_git_commit: "ask",
                execute_os: "allow",
                query_architect: "allow",
                query_code: "allow",
                query_git: "allow",
                query_os: "allow",
                query_text: "allow"
            },
            task_resume: "allow",
            "todowrite": "allow",
        },
        prompt: assistGitConflictPrompt,
        temperature: 0.3,
        tier: "balanced",
    },

    assist_troubleshoot: {
        color: colorWritableInteractiveOrchestrator,
        description: "Task `assist_troubleshoot` to troubleshoot assignment obstales",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_create: "ask",
            autocode_sandbox_delete: "allow",
            "context7*": "allow",
            doom_loop: "ask",
            external_directory: "ask",
            question: "allow",
            skill: {
                "*": "ask",
                "execute*": "allow",
                "learned-corrections-troubleshoot": "allow",
                "learned-env": "allow",
            },
            skill_learn_correction: "allow",
            skill_learn_env: "allow",
            task: {
                "*": "deny",
                execute_code: "allow",
                execute_debug: "allow",
                execute_os: "allow",
                execute_rest: "allow",
                execute_sandbox: "allow",
                execute_script: "allow",
                execute_ssh: "allow",
                "query*": "allow",
            },
            task_external: "ask",
            task_resume: "allow",
            "todo*": "allow",
        },
        prompt: assistTroubleshootPrompt,
        temperature: 0.5,
        tier: "smart",
    },

    auto_design: {
        color: colorAutonomousOrchestrator,
        description: "Task `auto_design` to redesign failed PROPOSAL.",
        hidden: false,
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "deny",
            external_directory: "allow",
            read: "allow",
            question: "allow",
            task: {
                "*": "deny",
                "query*": "allow",
            },
            task_external: "allow",
            task_resume: "allow",
        },
        prompt: autoDesignPrompt,
        temperature: 0.7,
        tier: "smart",
    },

    auto_feature: {
        color: colorAutonomousOrchestrator,
        description: "Task `auto_feature` to create new project, features: Implement new API's, classes, components, css styles, packages, scripts, templates, webpages",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_copy: sandboxCopyTargetPermission,
            autocode_sandbox_delete: "allow",
            doom_loop: "ask",
            skill: {
                "*": "deny",
                "code*": "allow",
                "execute*": "allow",
                "learned-preferences": "allow"
            },
            task: {
                "*": "deny",
                auto_test: "allow",
                auto_troubleshoot: "allow",
                execute_code: "allow",
                execute_os: "allow",
                query_code: "allow",
                query_git: "allow",
                query_text: "allow"
            },
            task_resume: "allow",
            "todo*": "allow",
        },
        prompt: autoFeaturePrompt,
        temperature: 0.3,
        tier: "smart",
    },

    auto_general: {
        color: colorAutonomousOrchestrator,
        description: "Fallback to `auto_general` when no specialized subagent clearly fits task",
        hidden: true,
        mode: "all",
        permission: {
            "*": "allow",
            doom_loop: "deny",
            skill: {
                "*": "allow"
            },
            task: {
                "*": "allow",
                "assist*": "deny",
                "auto*": "deny",
                build: "deny",
                design: "deny",
                plan: "deny",
                report: "deny",
                research: "deny",
                session: "deny",
            },
        },
        prompt: autoGeneralPrompt,
        tier: "smart",
    },

    auto_refactor: {
        color: colorAutonomousOrchestrator,
        description: "Task `auto_refactor` to upgrade, migrate or optimize code: improve security, performance, readability, efficiency, maintainability",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_create: "allow",
            autocode_sandbox_delete: "allow",
            doom_loop: "deny",
            skill: {
                "*": "deny",
                "code*": "allow",
                "execute*": "allow",
                "learned-preferences": "allow"
            },
            task: {
                "*": "deny",
                auto_troubleshoot: "allow",
                execute_code: "allow",
                execute_script: "allow",
                execute_os: "allow",
                query_code: "allow",
                query_git: "allow",
            },
            task_resume: "allow",
        },
        prompt: buildRefactorPrompt,
        temperature: 0.3,
        tier: "smart",
    },

    auto_research: {
        color: colorAutonomousOrchestrator,
        description: "Task `auto_research` to query data, create Research Reports, and find requested information",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "deny",
            task: {
                "*": "deny",
                "query*": "allow",
            },
            task_resume: "allow",
        },
        prompt: buildResearchPrompt,
        temperature: 0.7,
        tier: "smart",
    },

    auto_review_api: {
        color: colorAutonomousOrchestrator,
        description: "Task `auto_review_api` to review API changes: check endpoints, run tests, fix failures, and confirm API requirements are met",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_create: "allow",
            autocode_sandbox_delete: "allow",
            doom_loop: "deny",
            task: {
                "*": "deny",
                execute_code: "allow",
                execute_sandbox: "allow",
                execute_script: "allow",
                execute_os: "allow",
                execute_rest: "allow",
                query_architect: "allow",
                query_code: "allow",
                query_git: "allow",
                query_text: "allow",
            },
            task_resume: "allow",
        },
        prompt: buildReviewApiPrompt,
        temperature: 0.3,
        tier: "smart",
    },

    auto_review_ui: {
        color: colorAutonomousOrchestrator,
        description: "Task `auto_review_ui` to review UI changes: run application, inspect UI, run tests, and confirm UI requirements are met",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_create: "allow",
            autocode_sandbox_delete: "allow",
            doom_loop: "deny",
            task: {
                "*": "deny",
                execute_code: "allow",
                execute_sandbox: "allow",
                execute_script: "allow",
                execute_os: "allow",
                query_architect: "allow",
                query_browser: "allow",
                query_code: "allow",
                query_git: "allow",
                query_text: "allow",
            },
            task_resume: "allow",
        },
        prompt: buildReviewUiPrompt,
        temperature: 0.3,
        tier: "smart",
    },

    auto_test: {
        color: colorAutonomousOrchestrator,
        description: "Task `auto_test` to write or fix tests and, when explicitly needed, targeted code/config support for passing verification",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_create: "allow",
            autocode_sandbox_delete: "allow",
            doom_loop: "deny",
            edit: "allow",
            skill: {
                "*": "deny",
                "test*": "allow",
                "learned-corrections-test": "allow"
            },
            skill_learn_correction: "allow",
            task: {
                "*": "deny",
                execute_code: "allow",
                execute_script: "allow",
                execute_os: "allow",
                query_code: "allow",
                query_git: "allow",
            },
            task_resume: "allow",
        },
        prompt: buildTestPrompt,
        temperature: 0.3,
        tier: "smart",
    },

    auto_troubleshoot: {
        color: colorAutonomousOrchestrator,
        description: "Task `auto_troubleshoot` to orchestrate diagnosis, delegated fixes, and verification until resolved",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_create: "allow",
            autocode_sandbox_delete: "allow",
            "context7*": "allow",
            doom_loop: "deny",
            skill: {
                "*": "deny",
                "learned-corrections-troubleshoot": "allow",
                "learned-env": "allow",
            },
            skill_learn_correction: "allow",
            skill_learn_env: "allow",
            task: {
                "*": "deny",
                execute_code: "allow",
                execute_debug: "allow",
                execute_rest: "allow",
                execute_sandbox: "allow",
                execute_script: "allow",
                execute_os: "allow",
                execute_ssh: "allow",
                "query*": "allow",
            },
            task_resume: "allow",
            "todo*": "allow",
        },
        prompt: buildTroubleshootPrompt,
        temperature: 0.5,
        tier: "smart",
    },

    // Document Workers

    document_agents: {
        color: colorDocumentWorker,
        description: "Task `document_agents` to convert latest `README.md` to `AGENTS.md`.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_content_*": "allow",
            doom_loop: "deny",
            glob: "allow",
            skill: {
                "*": "deny",
                "author-rules": "allow"
            },
        },
        prompt: documentAgentsPrompt,
        temperature: 0.3,
        tier: "fast",
    },

    document_conventions: {
        color: colorDocumentWorker,
        description: "Task `document_conventions` to document naming conventions and project terminology.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_content_*": "allow",
            doom_loop: "deny",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "author-skill": "allow"
            },
        },
        prompt: documentConventionsPrompt,
        temperature: 0.3,
        tier: "fast",
    },

    document_code: {
        color: colorDocumentWorker,
        description: "Task `document_code` to document technical architecture and design decisions or sourcode code/config locations.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_content_*": "allow",
            doom_loop: "deny",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "author-skill": "allow"
            },
        },
        prompt: documentCodePrompt,
        temperature: 0.3,
        tier: "fast",
    },

    document_env: {
        color: colorDocumentWorker,
        description: "Task `document_env` to document related project to current project.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_content_*": "allow",
            doom_loop: "deny",
            skill: {
                "*": "deny",
                "learned-env*": "allow"
            },
            skill_learn_env: "allow",
            task: {
                "*": "deny",
                query_os: "allow",
                query_ssh: "allow"
            }
        },
        prompt: documentEnvPrompt,
        temperature: 0.3,
        tier: "fast",
    },

    document_install: {
        color: colorDocumentWorker,
        description: "Task `document_install` to document project installation and usage guide.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_content_*": "allow",
            doom_loop: "deny",
            glob: "allow",
            grep: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "author-skill": "allow"
            },
        },
        prompt: documentInstallPrompt,
        temperature: 0.3,
        tier: "fast",
    },

    document_prd: {
        color: colorDocumentWorker,
        description: "Task `document_prd` to document product requirements and user roles.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_content_*": "allow",
            doom_loop: "deny",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "author-skill": "allow"
            },
        },
        prompt: String(documentPrdPrompt),
        temperature: 0.3,
        tier: "fast",
    },

    document_ux: {
        color: colorDocumentWorker,
        description: "Task `document_ux` to document UX flows, navigation, and styling patterns",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_content_*": "allow",
            doom_loop: "deny",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "author-skill": "allow"
            },
        },
        prompt: documentUxPrompt,
        temperature: 0.3,
        tier: "fast",
    },

    // Execute workers

    execute_author: {
        color: colorWritableWorker,
        description: "Task `execute_author` to create or update md (Markdown) documents (like articles, tutorials, meeting agendas) or argentic instructions (like commands, skills or plans); It NEVER edit source code, program scripts or system config",
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_content*": "allow",
            autocode_logo_find: "allow",
            doom_loop: "deny",
            glob: "allow",
            skill: {
                "*": "deny",
                "author*": "allow",
            }
        },
        prompt: executeAuthorPrompt,
        temperature: 0.5,
        tier: "balanced",
    },

    execute_code: {
        color: colorWritableWorker,
        description: "Task `execute_code` to update the codebase with code, project scripts, config, and templates; `execute_code` NEVER write md files; NEVER run tests/code/scripts; Include pseudocode/algorithms, scope, identifiers, parameters, types, styling, content, error handling, parameter validation details in prompt.",
        mode: "subagent",
        permission: {
            "*": "deny",
            apply_patch: "allow",
            "context7*": "allow",
            doom_loop: "deny",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "code*": "allow",
                "design*": "allow",
                "learned-preferences": "allow"
            }
        },
        prompt: executeCodePrompt,
        temperature: 0.3,
        tier: "balanced",
    },

    execute_config: {
        color: colorWritableWorker,
        description: "Task `execute_config` to create or update configs or data files: Support only .conf, .ini, .properties, .json, .jsonc, yaml, yml; It NEVER edit source code.",
        mode: "subagent",
        permission: {
            "*": "deny",
            apply_patch: "allow",
            "autocode_content*": "allow",
            doom_loop: "deny",
            edit: "allow",
            glob: "allow",
            read: "allow"
        },
        prompt: executeConfigPrompt,
        temperature: 0.1,
        tier: "balanced",
    },

    execute_debug: {
        color: colorWritableWorker,
        description: "Task `execute_debug` to debug code flow leading to symptoms of reproducible bug as evidence of cause; Prompt must include bug symptoms and bug reproduction steps.",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "deny",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow"
        },
        prompt: executeDebugPrompt,
        temperature: 0.6,
        tier: "balanced",
    },

    execute_document: {
        color: colorDocumentWorker,
        description: "Task `execute_document` to update `AGENTS.md`, `README.md`, subagent skill files, remember architectural/design decisions or specs.",
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_content_*": "allow",
            doom_loop: "deny",
            skill: {
                "*": "deny",
                "author-caveman": "allow",
                "author-readme": "allow",
                "author-tutorial": "allow",
            },
            task: {
                "*": "deny",
                "document_*": "allow"
            },
            task_resume: "allow"
        },
        prompt: executeDocumentPrompt,
        temperature: 0.1,
        tier: "balanced",
    },

    execute_excel: {
        color: colorWritableWorker,
        description: "Task `execute_excel` to orchestrate excel workbook manipulations and data validation",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "deny",
            "excel_*": "allow",
            task: {
                "*": "deny",
                query_excel: "allow",
                query_text: "allow"
            },
            task_resume: "allow",
            "todo*": "allow",
        },
        prompt: executeExcelPrompt,
        temperature: 0.3,
        tier: "balanced",
    },

    execute_git_commit: {
        color: colorWritableWorker,
        description: "Task `execute_git_commit` only if reviewing changes and creating professional git commits",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_job_shelve: "allow",
            doom_loop: "deny",
            git_add: "allow",
            git_commit: "allow",
            git_log: "allow",
            git_reset: "allow",
            git_status: "allow",
            task_resume: "allow",
        },
        prompt: executeGitCommitPrompt,
        temperature: 0.5,
        tier: "balanced",
    },

    execute_os: {
        color: colorWritableWorker,
        description: "Task `execute_os` to execute single bash commands locally, *project* scripts, move/rename files/directories or administrate operating system; not for source code editing, browser automation, or online research",
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_content_*": "allow",
            bash: "allow",
            doom_loop: "deny",
            edit: "allow",
            external_directory: "allow",
            "filesystem*": "allow",
            glob: "allow",
            grep: "allow",
            "pty*": "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "execute-install": "allow",
                "execute-sandbox": "allow",
                "learned-corrections-os": "allow",
                "learned-env": "allow",
                "learned-permissions": "allow"
            },
            skill_learn_correction: "allow",
            skill_learn_env: "allow",
        },
        prompt: executeOsPrompt,
        temperature: 0.1,
        tier: "balanced",
    },

    execute_opencode: {
        color: colorWritableWorker,
        description: "Task `execute_opencode` to create or update OpenCode agent, command, skill and AGENTS.md files only.",
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_content_*": "allow",
            glob: "allow",
            skill: {
                "*": "deny",
                "author-skill": "allow",
                "author-agent": "allow",
                "author-command": "allow",
                "author-rules": "allow",
            },
        },
        prompt: executeOpencodePrompt,
        temperature: 0.3,
        tier: "balanced",
    },

    execute_rest: {
        color: colorReadOnlyWorker,
        description: "Task `execute_rest` to make REST/API requests on HTTP/HTTPS endpoints.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_rest: "allow",
            autocode_rest_grep: "allow",
            autocode_rest_response_eval: "allow",
            autocode_rest_response_read: "allow",
            doom_loop: "deny",
            skill: {
                "*": "deny",
                "learned-corrections-rest": "allow",
                "learned-env": "allow",
            },
            skill_learn_correction: "allow"
        },
        prompt: executeRestPrompt,
        temperature: 0.1,
        tier: "balanced",
    },

    execute_sandbox: {
        color: colorWritableWorker,
        description: "Task `execute_sandbox` to execute single CLI commands in sandbox environment; First create sandbox with `autocode_sandbox_create`, then you run multiple `execute_sandbox` tasks but you MUST include same `sandbox_name` in every `task` prompt",
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_cli: "allow",
            autocode_sandbox_copy: sandboxCopyTargetPermission,
            autocode_sandbox_edit: "allow",
            autocode_sandbox_glob: "allow",
            autocode_sandbox_grep: "allow",
            autocode_sandbox_read: "allow",
            doom_loop: "deny",
            skill: {
                "*": "deny",
                "learned-corrections-sandbox": "allow",
                "execute-install": "allow",
                "execute-sandbox": "allow",
                "learned-env": "allow",
            },
            skill_learn_correction: "allow",
            "todo*": "allow",
        },
        prompt: executeOsPrompt,
        temperature: 0.1,
        tier: "balanced",
    },

    execute_script: {
        color: colorWritableWorker,
        description: "Task `execute_script` to execute repetitive actions, document/media conversions, data translations, generate/render content, automate multiple commands, utilize scriptable libraries/frameworks to handle user request via *temporary* helper scripts like 'for each X file in Y do Z' or 'convert all A files to B' or 'generate X with Z' or 'use app A's output to invoke app B'; NOT intended to maintain project startup/test/deploymreproducable ent scripts",
        mode: "subagent",
        permission: {
            "*": "deny",
            apply_patch: "allow",
            autocode_sandbox_cli: "allow",
            autocode_sandbox_copy: sandboxCopyTargetPermission,
            autocode_sandbox_edit: "allow",
            autocode_sandbox_glob: "allow",
            autocode_sandbox_grep: "allow",
            autocode_sandbox_read: "allow",
            bash: "allow",
            doom_loop: "deny",
            edit: "allow",
            "filesystem*": "allow",
            glob: "allow",
            grep: "allow",
            "pty*": "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "learned-corrections-script": "allow",
                "learned-env": "allow",
                "execute-install": "allow",
                "execute-sandbox": "allow",
                "learned-permissions": "allow"
            },
            skill_learn_correction: "allow",
            skill_learn_env: "allow",
            "todo*": "allow",
            webfetch: "allow",
        },
        prompt: executeScriptPrompt,
        temperature: 0.3,
        tier: "balanced",
    },

    execute_ssh: {
        color: colorWritableWorker,
        description: "Task `execute_ssh` to access remote SSH/SFTP servers to execute remote commands or search/read/write remote files.",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "deny",
            "autocode_ssh*": "allow",
            skill: {
                "*": "deny",
                "execute-install": "allow",
                "learned-corrections-ssh": "allow",
                "learned-env-*": "allow",
                "learned-permissions": "allow"
            },
            skill_learn_correction: "allow",
            skill_learn_env: "allow",
            "todo*": "allow",
        },
        prompt: executeSshPrompt,
        temperature: 0.1,
        tier: "balanced",
    },

    // Query workers

    query_autocode: {
        color: colorReadOnlyWorker,
        description: "Task `query_autocode` for read-only OpenCode or AutoCode documentation queries or configuration advise.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_content_frontmatter_read: "allow",
            autocode_content_grep: "allow",
            autocode_content_read: "allow",
            autocode_content_toc: "allow",
            doom_loop: "deny",
            glob: "allow",
            skill: {
                "*": "deny",
                "author-agent": "allow",
                "author-command": "allow",
                "author-skill": "allow",
            },
            webfetch: "allow",
            "websearch*": "allow",
        },
        prompt: queryAutocodePrompt,
        temperature: 0.1,
        tier: "fast",
    },

    query_browser: {
        color: colorReadOnlyWorker,
        description: "Task `query_browser` for frontend development & testing - Debug, test and verify YOUR RUNNING APPLICATION: inspect UI behaviour, DOM elements, read console logs, analyze network requests, click UI elements, test performance and automate frontend testing. NOT for online research nor internet searches.",
        hidden: true,
        mode: "subagent",
        permission: {
            '*': "deny",
            "chrome*": "allow",
            "doom_loop": "deny",
            skill: {
                "*": "deny",
                "execute-ux": "allow",
            }
        },
        prompt: queryBrowserPrompt,
        tier: "fast",
    },

    query_code: {
        color: colorReadOnlyWorker,
        description: "Task `query_code` to search, find, locate, summarize, report or understand: source code, scripts or codebase; If file path and line number is known, call `read` tool instead.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "context7*": "allow",
            doom_loop: "deny",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "execute*": "allow",
            },
        },
        prompt: queryCodePrompt,
        temperature: 0.3,
        tier: "fast",
    },

    query_db: {
        color: colorReadOnlyWorker,
        description: "Task `query_db` to inspect environment-configured databases in read-only mode using Autocode DB tools",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_db_table: "allow",
            autocode_db_table_read: "allow",
            autocode_db_tables: "allow",
            doom_loop: "deny",
        },
        prompt: queryDbPrompt,
        temperature: 0.1,
        tier: "fast",
    },

    query_excel: {
        color: colorReadOnlyWorker,
        description: "Task `query_excel` to handle Excel workbook manipulations or data retrievals",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "deny",
            "excel_get*": "allow",
            "excel_read*": "allow",
            "excel_validate*": "allow",
            glob: "allow",
        },
        prompt: queryExcelPrompt,
        temperature: 0.1,
        tier: "fast",
    },

    query_git: {
        color: colorReadOnlyWorker,
        description: "Task `query_git` for git repo inspection (status, diff, log, show), recent project file changes, file history",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "deny",
            external_directory: "allow",
            "git_diff*": "allow",
            git_log: "allow",
            git_show: "allow",
            git_status: "allow",
            glob: "allow",
            grep: "allow",
            read: "allow",
        },
        prompt: queryGitPrompt,
        temperature: 0.1,
        tier: "fast",
    },

    query_os: {
        color: colorReadOnlyWorker,
        description: "Task `query_os` to find local host hardware, software, system, network, service, process, or OS-related information, versions, help-command info, status, or configurations",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_content_frontmatter_read: "allow",
            autocode_content_grep: "allow",
            autocode_content_read: "allow",
            autocode_content_toc: "allow",
            bash: "allow",
            doom_loop: "deny",
            external_directory: "allow",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "learned-env": "allow",
                "learned-permissions": "allow"
            },
            skill_learn_env: "allow"
        },
        prompt: queryOsPrompt,
        temperature: 0.1,
        tier: "fast",
    },

    query_skills: {
        color: colorReadOnlyWorker,
        description: "Task `query_skills` to ask with question about project architecture / design / PRD / conventions / technologies / documentation or development environment / user preferences / dangerous operations / how previous mistakes were corrected.",
        hidden: true,
        mode: "subagent",
        permission: {
            '*': "deny",
            skill: {
                "*": "deny",
                "design*": "allow",
                "execute*": "allow",
                "learned-corrections-primary": "allow",
                "learned-env*": "allow",
                "learned-permissions": "allow",
                "learned-preferences": "allow"
            },
            "todo*": "allow"
        },
        prompt: queryArchitectPrompt,
        tier: "fast",
    },

    query_ssh: {
        color: colorReadOnlyWorker,
        description: "Task `query_ssh` to find remote SSH/SFTP server files, hardware, software, system, network, service, process, or OS-related information, versions, help-command info, status, or configurations",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_ssh_content_frontmatter_read: "allow",
            autocode_ssh_content_grep: "allow",
            autocode_ssh_content_read: "allow",
            autocode_ssh_content_toc: "allow",
            autocode_ssh_command: "allow",
            autocode_ssh_glob: "allow",
            autocode_ssh_grep_file: "allow",
            autocode_ssh_list: "allow",
            "autocode_ssh_read_*": "allow",
            doom_loop: "deny",
            skill: {
                "*": "deny",
                "learned-env": "allow",
                "learned-permissions": "allow"
            },
            skill_learn_env: "allow"
        },
        prompt: querySshPrompt,
        temperature: 0.1,
        tier: "fast",
    },

    query_text: {
        color: colorReadOnlyWorker,
        description: "Task `query_text` to search, find, locate, read, extract, summarize: config file values, md sections, md front-matter, articles, yaml files, json files, templates, assets, resources; If file path and line number is known, call `read` tool instead.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_content_frontmatter_read: "allow",
            autocode_content_grep: "allow",
            autocode_content_read: "allow",
            autocode_content_toc: "allow",
            doom_loop: "deny",
            glob: "allow",
            grep: "allow",
            read: "allow"
        },
        prompt: queryTextPrompt,
        temperature: 0.1,
        tier: "fast",
    },

    query_web: {
        color: colorReadOnlyWorker,
        description: "Task `query_web` to search and read public ONLINE web sources: documentation, articles, forums, GitHub, news, framework API/SDKs, public repo examples",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "context7*": "allow",
            doom_loop: "deny",
            "todo*": "allow",
            webfetch: "allow",
            "websearch*": "allow",
        },
        prompt: queryWebPrompt,
        temperature: 0.5,
        tier: "fast",
    },

    // Temporary agents: execute 1 task then move out of the way so that original agent can continue

    temp_concept: {
        color: colorWritableWorker,
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_concept_create: "allow",
            skill: {
                "*": "deny",
                "author-article": "allow",
                autocode_agent_swap: "allow",
            }
        },
        prompt: tempConceptPrompt,
        tier: "fast"
    },

    temp_execute: {
        color: colorWritableWorker,
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_agent_swap: "allow",
            autocode_job_list: "allow",
            autocode_job_status: "allow",
            question: "allow",
        },
        prompt: "---",
        temperature: 0.5,
        tier: "fast",
    },

    temp_manual: {
        color: colorReadOnlyWorker,
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            skill: {
                "learned-permissions": "allow"
            }
        },
        prompt: tempManualPrompt,
        temperature: 0.3,
        tier: "fast",
    },

    temp_output: {
        color: colorReadOnlyWorker,
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_session_context: "allow",
        },
        prompt: "---",
        temperature: 0,
        tier: "fast",
    },

    temp_report: {
        color: colorReadOnlyWorker,
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
        },
        prompt: tempReportPrompt,
        temperature: 0.3,
        tier: "fast",
    },

    temp_session: {
        color: colorWritableWorker,
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_session_create: "allow",
        },
        prompt: "---",
        temperature: 0.5,
        tier: "fast",
    },

    temp_review_reject: {
        color: colorWritableWorker,
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_job_shelve: "allow",
            git_reset: "allow",
        },
        prompt: "---",
        temperature: 0.5,
        tier: "fast",
    },

    temp_shelve: {
        color: colorWritableWorker,
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_job_shelve: "allow",
        },
        prompt: "---",
        temperature: 0.5,
        tier: "fast",
    },

}

export function buildAgents(
    externalDirectories: ExternalDirectoryRules = {},
    sandboxSupportOverride?: SandboxPlatformSupportOptions,
): AgentMap {
    return applyBundledAgentPolicy(baseAgents, externalDirectories, sandboxSupportOverride)
}

export function getAgentPermission(agentName: string, externalDirectories: ExternalDirectoryRules = {}): AutocodeAgentConfig["permission"] {
    return buildAgents(externalDirectories)[agentName]?.permission
}

export function getAgentTier(agentName: string): ModelTier | undefined {
    return baseAgents[agentName]?.tier
}

export const agents: AgentMap = buildAgents()
