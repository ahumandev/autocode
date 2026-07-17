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
import { editPrompt } from "./prompts/edit";
import { executeAuthorPrompt } from "./prompts/execute_author";
import { executeCodePrompt } from "./prompts/execute_code";
import { executeDebugPrompt } from "./prompts/execute_debug";
import { executeDocumentPrompt } from "./prompts/execute_document"
import { executeExcelPrompt } from "./prompts/execute_excel";
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

const sandboxToolPermissionKeys = ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy", "autocode_sandbox_config_edit", "autocode_sandbox_config_read", "autocode_sandbox_config_remove"] as const

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

    title: {
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
        description: "Assist with general tasks.",
        hidden: false,
        mode: "primary",
        permission: {
            "*": "deny",
            autocode_agent_swap: "allow",
            autocode_dependencies: "allow",
            autocode_job_status: "allow",
            autocode_sandbox_create: "ask",
            autocode_sandbox_delete: "allow",
            autocode_session_create: "allow",
            doom_loop: "ask",
            git_commit: "allow",
            question: "allow",
            skill: {
                "*": "deny",
                "git-commit": "allow",
                "learned-permissions": "allow"
            },
            "skill_learn_*": "allow",
            task: {
                "*": "allow",
                "auto*": "deny",
                auto_research: "allow",
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
        description: "Autonomously follow plan to solve a problem.",
        hidden: false,
        mode: "primary",
        permission: {
            "*": "deny",
            autocode_agent_swap: "allow",
            autocode_job_status: "allow",
            autocode_session_create: "allow",
            git_commit: "allow",
            skill: {
                "*": "deny",
                "git-commit": "allow",
                "learned-permissions": "allow"
            },
            "skill_learn_*": "allow",
            task: {
                "*": "deny",
                "auto_*": "allow",
                "query_*": "allow"
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
        description: "Design and propose solutions.",
        hidden: false,
        mode: "primary",
        permission: {
            "*": "deny",
            autocode_agent_execute: "allow",
            autocode_concept_create: "allow",
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

    edit: {
        color: colorWritableInteractiveOrchestrator,
        description: "Edit files directly (fast & cheap).",
        hidden: false,
        mode: "primary",
        permission: {
            "*": "deny",
            "autocode_config_*": "allow",
            "autocode_md_*": "allow",
            apply_patch: "allow",
            autocode_agent_swap: "allow",
            autocode_session_create: "allow",
            doom_loop: "ask",
            edit: "allow",
            external_directory: "ask",
            git_commit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            question: "allow",
            read: "allow",
            write: "allow",
            skill: {
                "*": "deny",
                "author-article": "allow",
                "code*": "allow",
                "design*": "allow",
                "git-commit": "allow",
                "learned-preferences": "allow"
            },
            "skill_learn_*": "allow"
        },
        prompt: editPrompt,
        tier: "balanced"
    },

    research: {
        color: colorReadOnlyInteractiveOrchestrator,
        description: "Research topics & answer questions.",
        hidden: false,
        mode: "primary",
        permission: {
            "*": "deny",
            autocode_session_create: "allow",
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
        description: "task assist_browser with interactive browser automation tasks. It browser than can: access that can fill forms, submit, save, upload, pair with user for manual steps like login, captcha, and 2FA. Browser state persists across calls via `task_id` so tab and login session are not re-discovered.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "chrome*": "allow",
            doom_loop: "ask",
            question: "allow",
            skill: {
                "*": "deny",
                "execute-ux": "allow",
            },
            skill_read: "allow",
            "todo*": "allow",
        },
        prompt: assistBrowserPrompt,
        temperature: 0.3,
        tier: "balanced",
    },

    assist_git_conflict: {
        color: colorWritableInteractiveOrchestrator,
        description: "task assist_git_conflict to resolve git merge conflicts.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "ask",
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
            skill_read: "allow",
            task: {
                "*": "deny",
                execute_code: "allow",
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
        description: "task assist_troubleshoot to troubleshoot ASSIGNMENT obstacles.",
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
            skill_read: "allow",
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
            task_external: "allow",
            task_resume: "allow",
            "todo*": "allow",
        },
        prompt: assistTroubleshootPrompt,
        temperature: 0.5,
        tier: "smart",
    },

    auto_design: {
        color: colorAutonomousOrchestrator,
        description: "task auto_design to redesign failed PROPOSALS.",
        hidden: false,
        mode: "subagent",
        permission: {
            "*": "deny",
            external_directory: "deny",
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
        description: "task auto_feature to create new project features: Implement new API's, classes, components, css styles, packages, scripts, templates, webpages",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_copy: sandboxCopyTargetPermission,
            autocode_sandbox_delete: "allow",
            skill: {
                "*": "deny",
                "code*": "allow",
                "execute*": "allow",
                "learned-preferences": "allow"
            },
            skill_read: "allow",
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
        description: "Only fallback to auto_general as last resort when no specialized subagent clearly fits task.",
        hidden: true,
        mode: "all",
        permission: {
            "*": "allow",
            doom_loop: "deny",
            external_directory: "deny",
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
                "temp*": "deny"
            },
        },
        prompt: autoGeneralPrompt,
        tier: "smart",
    },

    auto_refactor: {
        color: colorAutonomousOrchestrator,
        description: "task auto_refactor to upgrade, migrate, or optimize code: improve security, performance, readability, efficiency, maintainability.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_create: "allow",
            autocode_sandbox_delete: "allow",
            skill: {
                "*": "deny",
                "code*": "allow",
                "execute*": "allow",
                "learned-preferences": "allow"
            },
            skill_read: "allow",
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
        description: "task auto_research to answer complex questions like research topics, architectural overview, code flow across multiple files, consolidating data from multiple sources, compare specs with implementation",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
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
        description: "task auto_review_api to review API changes: check endpoints, run tests, fix failures, and confirm API requirements are met",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_create: "allow",
            autocode_sandbox_delete: "allow",
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
        description: "task auto_review_ui to review UI changes: run application, inspect UI, run tests, and confirm UI requirements are met",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_create: "allow",
            autocode_sandbox_delete: "allow",
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
        description: "task auto_test to write or fix tests and, when explicitly needed, targeted code/config support for passing verification",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_create: "allow",
            autocode_sandbox_delete: "allow",
            edit: "allow",
            skill: {
                "*": "deny",
                "test*": "allow",
                "learned-corrections-test": "allow"
            },
            skill_learn_correction: "allow",
            skill_read: "allow",
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
        description: "task auto_troubleshoot to troubleshoot obstacles, bugs and issues.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_create: "allow",
            autocode_sandbox_delete: "allow",
            "context7*": "allow",
            skill: {
                "*": "deny",
                "learned-corrections-troubleshoot": "allow",
                "learned-env": "allow",
            },
            skill_learn_correction: "allow",
            skill_learn_env: "allow",
            skill_read: "allow",
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
        description: "task document_agents to convert latest `README.md` to `AGENTS.md`.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_md_read": "allow",
            "autocode_md_edit": "allow",
            skill: {
                "*": "deny",
                "author-rules": "allow"
            },
            skill_read: "allow",
        },
        prompt: documentAgentsPrompt,
        temperature: 0.3,
        tier: "fast",
    },

    document_conventions: {
        color: colorDocumentWorker,
        description: "task document_agents to document naming conventions and project terminology.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_read": "allow",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "author-skill": "allow"
            },
            skill_read: "allow",
            skill_write: "allow",
        },
        prompt: documentConventionsPrompt,
        temperature: 0.3,
        tier: "fast",
    },

    document_code: {
        color: colorDocumentWorker,
        description: "task document_agents to document technical architecture and design decisions or source code/config locations.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_read": "allow",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "author-skill": "allow"
            },
            skill_read: "allow",
            skill_write: "allow",
        },
        prompt: documentCodePrompt,
        temperature: 0.3,
        tier: "fast",
    },

    document_env: {
        color: colorDocumentWorker,
        description: "task document_agents to document related project to current project.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_read": "allow",
            grep: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "learned-env*": "allow"
            },
            skill_learn_env: "allow",
            skill_read: "allow",
            skill_write: "allow",
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
        description: "task document_agents to document project installation and usage guide.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_md_*": "allow",
            glob: "allow",
            grep: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "author-skill": "allow"
            },
            skill_read: "allow",
            skill_write: "allow",
        },
        prompt: documentInstallPrompt,
        temperature: 0.3,
        tier: "fast",
    },

    document_prd: {
        color: colorDocumentWorker,
        description: "task document_agents to document product requirements and user roles.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_read": "allow",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "author-skill": "allow"
            },
            skill_read: "allow",
            skill_write: "allow",
        },
        prompt: String(documentPrdPrompt),
        temperature: 0.3,
        tier: "fast",
    },

    document_ux: {
        color: colorDocumentWorker,
        description: "task document_agents to document UX flows, navigation, and styling patterns",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_read": "allow",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "author-skill": "allow"
            },
            skill_read: "allow",
            skill_write: "allow",
        },
        prompt: documentUxPrompt,
        temperature: 0.3,
        tier: "fast",
    },

    // Execute workers

    execute_author: {
        color: colorWritableWorker,
        description: "task execute_author to create/edit/review/revise md (Markdown) content (like articles, documents, faqs, tutorials) or argentic instructions (like commands, prompts, skills or plans); It NEVER edit source code, program scripts or system config; NEVER review md content yourself.",
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_md_*": "allow",
            autocode_logo_find: "allow",
            skill: {
                "*": "deny",
                "author*": "allow",
            },
            skill_read: "allow",
        },
        prompt: executeAuthorPrompt,
        temperature: 0.5,
        tier: "balanced",
    },

    execute_code: {
        color: colorWritableWorker,
        description: "task execute_code to update the codebase with code, permanent project scripts, config, and templates; NEVER write md files; NEVER run tests/code/scripts; Include pseudocode/algorithms, scope, identifiers, parameters, types, styling, content, error handling, parameter validation details in prompt.",
        mode: "subagent",
        permission: {
            "*": "deny",
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
            },
            skill_read: "allow",
        },
        prompt: executeCodePrompt,
        temperature: 0.3,
        tier: "balanced",
    },

    execute_config: {
        color: colorWritableWorker,
        description: "task execute_config to create or update configs or data files: Support only .conf, .ini, .properties, .json, .jsonc, yaml, yml; It NEVER edit source code.",
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_*": "allow",
        },
        prompt: executeConfigPrompt,
        temperature: 0.1,
        tier: "balanced",
    },

    execute_debug: {
        color: colorWritableWorker,
        description: "task execute_debug to debug code flow leading to symptoms of reproducible bug as evidence of cause; Prompt must include bug symptoms and bug reproduction steps.",
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_*": "allow",
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
        description: "task execute_document to update `AGENTS.md`, `README.md`, subagent skill files, remember architectural/design decisions or specs.",
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_md_read": "allow",
            "autocode_md_edit": "allow",
            skill: {
                "*": "deny",
                "author-caveman": "allow",
                "author-readme": "allow",
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
        description: "task execute_excel with excel related tasks like workbook manipulations and data validation.",
        mode: "subagent",
        permission: {
            "*": "deny",
            edit: "allow",
            "excel_*": "allow",
            read: "allow",
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

    execute_os: {
        color: colorWritableWorker,
        description: "task execute_os to copy/move/delete/permission files, start/stop apps/services, run scripts/commands/tests.",
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_*": "allow",
            edit: "allow",
            bash: "allow",
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
            skill_read: "allow",
        },
        prompt: executeOsPrompt,
        temperature: 0.1,
        tier: "balanced",
    },

    execute_opencode: {
        color: colorWritableWorker,
        description: "task execute_opencode to create or update OpenCode agent, command, skill and AGENTS.md files only.",
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_*": "allow",
            "autocode_md_*": "allow",
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
        description: "task execute_rest to make REST/API requests on HTTP/HTTPS endpoints.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_config_read: "allow",
            autocode_rest: "allow",
            grep: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "learned-corrections-rest": "allow",
                "learned-env": "allow",
            },
            skill_learn_correction: "allow",
            skill_read: "allow",
        },
        prompt: executeRestPrompt,
        temperature: 0.1,
        tier: "balanced",
    },

    execute_sandbox: {
        color: colorWritableWorker,
        description: "task execute_sandbox to execute CLI commands in sandbox environment; First create sandbox with `autocode_sandbox_create`, then you run multiple `execute_sandbox` tasks but you MUST include same `sandbox_name` in every `task` prompt",
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_sandbox_cli: "allow",
            autocode_sandbox_copy: sandboxCopyTargetPermission,
            autocode_sandbox_edit: "allow",
            autocode_sandbox_glob: "allow",
            autocode_sandbox_grep: "allow",
            autocode_sandbox_read: "allow",
            autocode_sandbox_config_edit: "allow",
            autocode_sandbox_config_read: "allow",
            autocode_sandbox_config_remove: "allow",
            skill: {
                "*": "deny",
                "learned-corrections-sandbox": "allow",
                "execute-install": "allow",
                "execute-sandbox": "allow",
                "learned-env": "allow",
            },
            skill_learn_correction: "allow",
            skill_read: "allow",
            "todo*": "allow",
        },
        prompt: executeOsPrompt,
        temperature: 0.1,
        tier: "balanced",
    },

    execute_script: {
        color: colorWritableWorker,
        description: "task execute_script to execute repetitive actions, data/document/media conversions, generate/render content, utilize scriptable libraries/utils via *temporary* scripts like 'for each X file in Y do Z' or 'convert all A files to B' or 'generate X with Z' or 'use app A's output to invoke app B'; NOT for *permanent* project scripts",
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_*": "allow",
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
            skill_read: "allow",
            "todo*": "allow",
            webfetch: "allow",
        },
        prompt: executeScriptPrompt,
        temperature: 0.3,
        tier: "balanced",
    },

    execute_ssh: {
        color: colorWritableWorker,
        description: "task execute_ssh to access remote SSH/SFTP servers to execute remote commands or search/read/write remote files.",
        mode: "subagent",
        permission: {
            "*": "deny",
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
            skill_read: "allow",
            "todo*": "allow",
        },
        prompt: executeSshPrompt,
        temperature: 0.1,
        tier: "balanced",
    },

    // Query workers

    query_autocode: {
        color: colorReadOnlyWorker,
        description: "task query_autocode for OpenCode or AutoCode documentation or configuration related queries or advise.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_read": "allow",
            "autocode_md_read": "allow",
            "autocode_md_frontmatter_read": "allow",
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
        description: "task query_browser to handle frontend ui testing with real browser. It can Debug, test and verify YOUR RUNNING APPLICATION: inspect UI behaviour, DOM elements, read console logs, analyze network requests, click UI elements, test performance and automate frontend testing. NOT for online research nor internet searches.",
        hidden: true,
        mode: "subagent",
        permission: {
            '*': "deny",
            "chrome*": "allow",
            skill: {
                "*": "deny",
                "execute-ux": "allow",
            },
            skill_read: "allow",
        },
        prompt: queryBrowserPrompt,
        tier: "fast",
    },

    query_code: {
        color: colorReadOnlyWorker,
        description: "task query_code to find or summarize: source code, scripts or codebase; NEVER query md content; NEVER to return full file content",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "context7*": "allow",
            glob: "allow",
            grep: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "execute*": "allow",
            },
            skill_read: "allow",
        },
        prompt: queryCodePrompt,
        temperature: 0.3,
        tier: "fast",
    },

    query_db: {
        color: colorReadOnlyWorker,
        description: "task query_db to inspect environment-configured databases in read-only mode using Autocode DB tools",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            autocode_db_table: "allow",
            autocode_db_table_read: "allow",
            autocode_db_tables: "allow",
        },
        prompt: queryDbPrompt,
        temperature: 0.1,
        tier: "fast",
    },

    query_excel: {
        color: colorReadOnlyWorker,
        description: "task query_excel to read excel files.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
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
        description: "task query_git to inspect Git repos (status, diff, log, show), recent project file changes, file history.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
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
        description: "task query_os to find OS provided info like: local host hardware, software, system, network, service, process, versions, help-command info, status.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_read": "allow",
            "autocode_md_frontmatter_read": "allow",
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
            skill_learn_env: "allow",
            skill_read: "allow",
        },
        prompt: queryOsPrompt,
        temperature: 0.1,
        tier: "fast",
    },

    query_skills: {
        color: colorReadOnlyWorker,
        description: "task query_skills to ask questions about project architecture / design / PRD / conventions / technologies / documentation or development environment / user preferences / dangerous operations / how previous mistakes were corrected.",
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
        description: "task query_ssh to find on remote SSH/SFTP servers: files, configuration, process status, etc.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_ssh_config_read": "allow",
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
            skill_learn_env: "allow",
            skill_read: "allow",
        },
        prompt: querySshPrompt,
        temperature: 0.1,
        tier: "fast",
    },

    query_text: {
        color: colorReadOnlyWorker,
        description: "task query_text to find/read/summarize: config file values, md content, md front-matter, articles/document sections, yaml files, json files, templates, assets, resources; NEVER to return full file content.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_config_read": "allow",
            "autocode_md_frontmatter_read": "allow",
            "autocode_md_read": "allow",
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
        description: "task query_web to search and read public ONLINE web sources: documentation, articles, forums, GitHub, news, framework API/SDKs, public repo examples",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "context7*": "allow",
            "todo*": "allow",
            webfetch: "allow",
            "websearch*": "allow",
        },
        prompt: queryWebPrompt,
        temperature: 0.5,
        tier: "fast",
    },

    // Temporary agents: execute 1 task then move out of the way so that original agent can continue

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
