import type { AgentConfig } from "@opencode-ai/sdk/v2"
import type { ExternalDirectoryRules, ModelTier, PermissionAction, SkillCategory, TierConfig } from "@/config"
import type { PlatformCapabilities } from "@/utils/platform"
import type { ExternalSkill } from "../utils/external"
import type { PermissionRule } from "@/utils/permissions"
import { assistBrowserPrompt } from "./prompts/assist_browser";
import { assistGitConflictPrompt } from "./prompts/assist_git_conflict";
import { assistPrompt } from "./prompts/assist";
import { autoDesignPrompt } from "./prompts/auto_design";
import { autoAuthorPrompt } from "./prompts/auto_author";
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
import { buildExecuteOsPrompt } from "./prompts/execute_os";
import { executeOpencodePrompt } from "./prompts/execute_opencode";
import { executeRestPrompt } from "./prompts/execute_rest";
import { executeScriptPrompt } from "./prompts/execute_script";
import { isSandboxPlatformSupported, type SandboxPlatformSupportOptions } from "@/utils/sandbox"
import { queryAutocodePrompt } from "./prompts/query_autocode";
import { queryBrowserPrompt } from "./prompts/query_browser";
import { queryCodePrompt } from "./prompts/query_code";
import { queryDbPrompt } from "./prompts/query_db";
import { queryExcelPrompt } from "./prompts/query_excel";
import { queryGitPrompt } from "./prompts/query_git";
import { queryOsPrompt as buildQueryOsPrompt } from "./prompts/query_os";
import { querySkillsPrompt } from "./prompts/query_skills";
import { queryTextPrompt } from "./prompts/query_text";
import { queryWebPrompt } from "./prompts/query_web";
import { queryYoutubePrompt } from "./prompts/query_youtube";
import { advisePrompt } from "./prompts/advise";
import { spyPrompt } from "./prompts/spy";
import { documentEnvPrompt } from "./prompts/document_env";
import { querySshPrompt } from "./prompts/query_ssh";
import { executeSshPrompt } from "./prompts/execute_ssh";
import { executeConfigPrompt } from "./prompts/execute_config";
import { queryConfigPrompt } from "./prompts/query_config";

type PermissionTargetRules = Record<string, PermissionAction>
type AutocodePermissionRule = PermissionAction | PermissionTargetRules | PermissionRule[]
type AutocodeTaskPermissionRules = Record<string, AutocodePermissionRule>
type AutocodePermissionObject = {
    task?: PermissionAction | AutocodeTaskPermissionRules
    skill?: PermissionAction | Record<string, PermissionAction>
    [key: string]: AutocodePermissionRule | AutocodeTaskPermissionRules | undefined
}
type LegacyAgentConfig = Omit<AgentConfig, "permission" | "permissions"> & { permission?: PermissionAction | AutocodePermissionObject, tier?: ModelTier }
export type AutocodeAgentConfig = Omit<AgentConfig, "permission" | "permissions"> & { permissions?: PermissionRule[], tier?: ModelTier }
type AgentMap = Record<string, LegacyAgentConfig>
type V2AgentMap = Record<string, AutocodeAgentConfig>
type PermissionObject = AutocodePermissionObject
type SandboxPlatformPolicyOptions = NodeJS.Platform | SandboxPlatformSupportOptions

const sandboxCopyTargetPermission: PermissionTargetRules = {
    sandbox_target: "allow",
    local_target: "allow",
}

const sandboxToolPermissionKeys = ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy", "autocode_sandbox_config_edit", "autocode_sandbox_config_read", "autocode_sandbox_config_remove"] as const
const sandboxLinuxCapabilities: PlatformCapabilities = { isWindows: false, commandEnvironment: "linux" }

const colorAutonomousOrchestrator = "#AA0000"
const colorWritableInteractiveOrchestrator = "#00AA00"
const colorReadOnlyInteractiveOrchestrator = "#0000AA"
const colorWritableWorker = "#AA8300"
const colorReadOnlyWorker = "#00AAAA"
const colorDocumentWorker = "#AA00AA"

const CATEGORY_AGENTS: Record<SkillCategory, string[]> = {
    bash: ["execute-os", "execute-script"],
    code: ["execute-code"],
    design: ["assist", "auto", "design"],
    test: ["auto-test"],
}

function createBaseAgents(capabilities: PlatformCapabilities): AgentMap {
    return {

        // Build-in opencode

        build: {
            disable: true,
        },

        compaction: {
            tier: "context",
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

        title: {
            tier: "cheap",
        },

        // Primary Orchestrators

        advise: {
            color: colorReadOnlyInteractiveOrchestrator,
            description: "👨 Advise how to manually fix problems.",
            hidden: false,
            mode: "primary",
            permission: {
                "*": "deny",
                autocode_config_read: "allow",
                autocode_md_frontmatter_read: "allow",
                autocode_md_read: "allow",
                autocode_memory_recall: "allow",
                autocode_memory_forget: "allow",
                autocode_session_create: "allow",
                doom_loop: "ask",
                git_commit: "ask",
                learn: "allow",
                question: "allow",
                skill: {
                    "*": "deny",
                    "assist-*": "allow",
                    "author-*": "allow",
                    "codebase-design": "allow", // From mattpocock/skills
                    "git-commit": "allow",
                    "primary-manual*": "allow",
                    "ui-craft": "allow",
                },
                subagent: {
                    "*": "deny",
                    "auto-research": "allow",
                    "query*": "allow",
                },
                "todo*": "allow",
            },
            prompt: advisePrompt,
            tier: "balanced",
        },

        assist: {
            color: colorWritableInteractiveOrchestrator,
            description: "🧑‍💻 Assist interactively with problems.",
            hidden: false,
            mode: "primary",
            permission: {
                "*": "deny",
                "autocode_config_*": "allow",
                "autocode_md_*": "allow",
                autocode_memory_recall: "allow",
                autocode_memory_forget: "allow",
                autocode_sandbox_create: "ask",
                autocode_sandbox_delete: "allow",
                autocode_session_create: "allow",
                doom_loop: "ask",
                edit: "allow",
                git_commit: "allow",
                learn: "allow",
                question: "allow",
                skill: {
                    "*": "deny",
                    "assist-*": "allow",
                    "author-*": "allow",
                    "codebase-design": "allow", // From mattpocock/skills
                    "git-commit": "allow",
                    "primary-manual*": "allow",
                    "ui-craft": "allow",
                },
                subagent: {
                    "*": "allow",
                    "auto*": "deny",
                    "auto-research": "allow",
                    build: "deny",
                    "document*": "deny",
                    plan: "deny",
                    "execute-document": "allow",
                },
                "todo*": "allow"
            },
            prompt: assistPrompt,
            tier: "balanced",
        },

        auto: {
            color: colorAutonomousOrchestrator,
            description: "🤖 Autonomously solve problems.",
            hidden: false,
            mode: "primary",
            permission: {
                "*": "deny",
                autocode_session_create: "allow",
                git_commit: "allow",
                skill: {
                    "*": "deny",
                    "git-commit": "allow",
                    "primary-manual": "allow"
                },
                learn: "allow",
                autocode_memory_recall: "allow",
                autocode_memory_forget: "allow",
                subagent: {
                    "*": "deny",
                    "auto-*": "allow",
                    "query-*": "allow"
                },
                "todo*": "allow",
            },
            prompt: autoPrompt,
            temperature: 0.4,
            tier: "smart",
        },

        design: {
            color: colorReadOnlyInteractiveOrchestrator,
            description: "📐 Design and propose solutions.",
            hidden: false,
            mode: "primary",
            permission: {
                "*": "deny",
                autocode_concept_create: "allow",
                autocode_concept_list: "allow",
                autocode_concept_read: "allow",
                autocode_job_list: "allow",
                autocode_memory_recall: "allow",
                autocode_memory_forget: "allow",
                autocode_session_create: "allow",
                doom_loop: "ask",
                external_directory: "ask",
                learn: "allow",
                question: "allow",
                skill: {
                    "*": "deny",
                    "codebase-design": "allow", // From mattpocock/skills
                },
                subagent: {
                    "*": "deny",
                    "auto-research": "allow",
                    "query*": "allow",
                },
                "todo*": "allow",
            },
            prompt: designPrompt,
            temperature: 0.7,
            tier: "balanced",
        },

        spy: {
            color: colorReadOnlyInteractiveOrchestrator,
            description: "🕵️ Spy on private information.",
            hidden: false,
            mode: "primary",
            permission: {
                "*": "deny",
                autocode_config_read: "allow",
                autocode_db_table: "allow",
                autocode_db_table_read: "allow",
                autocode_db_tables: "allow",
                autocode_md_frontmatter_read: "allow",
                autocode_md_read: "allow",
                autocode_memory_forget: "allow",
                autocode_ssh_config_read: "allow",
                autocode_ssh_glob: "allow",
                autocode_ssh_grep_file: "allow",
                autocode_ssh_list: "allow",
                "autocode_ssh_read_*": "allow",
                "excel_get*": "allow",
                "excel_read*": "allow",
                "excel_validate*": "allow",
                glob: "allow",
                grep: "allow",
                read: "allow"
            },
            prompt: spyPrompt,
            tier: "spy",
        },

        // Secondary Orchestrators

        "assist-browser": {
            color: colorWritableInteractiveOrchestrator,
            description: "Use assist-browser subagent with interactive browser automation tasks. It browser than can: access that can fill forms, submit, save, upload, pair with user for manual steps like login, captcha, and 2FA. Browser state persists across calls via `task_id` so tab and login session are not re-discovered.",
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
                learn: "allow",
                "todo*": "allow",
            },
            prompt: assistBrowserPrompt,
            temperature: 0.3,
            tier: "operator",
        },

        "assist-git-conflict": {
            color: colorWritableInteractiveOrchestrator,
            description: "Use assist-git-conflict subagent to resolve git merge conflicts.",
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
                subagent: {
                    "*": "deny",
                    "execute-code": "allow",
                    "execute-os": "allow",
                    "query-code": "allow",
                    "query-git": "allow",
                    "query-os": "allow",
                    "query-text": "allow"
                },
                "todowrite": "allow",
            },
            prompt: assistGitConflictPrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        "auto-author": {
            color: colorAutonomousOrchestrator,
            description: "Use auto-author subagent to author or review: articles, docs, excel reports or agentic skills or prompts; NOT for config or source code comments.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_md_*": "allow",
                edit: "allow",
                subagent: {
                    "*": "deny",
                    "document-*": "allow",
                    "execute-author": "allow",
                    "execute-document": "allow",
                    "query-text": "allow",
                    "query-web": "allow",
                    "query-youtube": "allow",
                },
            },
            prompt: autoAuthorPrompt,
            temperature: 0.7,
            tier: "smart",
        },

        "auto-design": {
            color: colorAutonomousOrchestrator,
            description: "Use auto-design subagent to redesign failed PROPOSALS when new unresolvable blocking CONSTRAINTS arise. Always try resolve OBSTACLES first with auto-troubleshoot. Only use auto-design as last resort when unresolvable root cause (new CONSTRAINT) is clear.",
            hidden: false,
            mode: "subagent",
            permission: {
                "*": "deny",
                external_directory: "deny",
                read: "allow",
                question: "allow",
                subagent: {
                    "*": "deny",
                    "query*": "allow",
                },
            },
            prompt: autoDesignPrompt,
            temperature: 0.7,
            tier: "smart",
        },

        "auto-feature": {
            color: colorAutonomousOrchestrator,
            description: "Use auto-feature subagent to create new project features: Implement new API's, classes, components, css styles, packages, scripts, templates, webpages",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                autocode_sandbox_copy: sandboxCopyTargetPermission,
                autocode_sandbox_delete: "allow",
                skill: {
                    "*": "deny",
                    "code*": "allow",
                    "codebase-design": "allow", // From mattpocock/skills
                    "execute*": "allow",
                    "vue-best-practices": "allow",
                    "ui-craft": "allow",
                },
                subagent: {
                    "*": "deny",
                    "auto-test": "allow",
                    "auto-troubleshoot": "allow",
                    "execute-code": "allow",
                    "execute-os": "allow",
                    "query-code": "allow",
                    "query-git": "allow",
                    "query-text": "allow"
                },
                "todo*": "allow",
            },
            prompt: autoFeaturePrompt,
            temperature: 0.3,
            tier: "smart",
        },

        "auto-general": {
            color: colorAutonomousOrchestrator,
            description: "Only use auto-general subagent as last resort when no specialized subagent clearly fits task.",
            hidden: true,
            mode: "all",
            permission: {
                "*": "allow",
                doom_loop: "deny",
                external_directory: "deny",
                skill: {
                    "*": "allow",
                    "assist-*": "deny",
                    "primary-*": "deny",
                },
                subagent: {
                    "*": "allow",
                    "assist*": "deny",
                    "auto*": "deny",
                    build: "deny",
                    design: "deny",
                    plan: "deny",
                    report: "deny",
                    session: "deny",
                    "temp*": "deny"
                },
            },
            prompt: autoGeneralPrompt,
            tier: "balanced",
        },

        "auto-refactor": {
            color: colorAutonomousOrchestrator,
            description: "Use auto-refactor subagent to upgrade, migrate, or optimize code: improve security, performance, readability, efficiency, maintainability; NOT for tests",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                autocode_sandbox_create: "allow",
                autocode_sandbox_delete: "allow",
                skill: {
                    "*": "deny",
                    "code*": "allow",
                    "codebase-design": "allow", // From mattpocock/skills
                    "execute*": "allow",
                },
                subagent: {
                    "*": "deny",
                    "auto-troubleshoot": "allow",
                    "execute-code": "allow",
                    "execute-script": "allow",
                    "execute-os": "allow",
                    "query-code": "allow",
                    "query-git": "allow",
                },
            },
            prompt: buildRefactorPrompt,
            temperature: 0.3,
            tier: "smart",
        },

        "auto-research": {
            color: colorAutonomousOrchestrator,
            description: "Use auto-research subagent to answer complex questions like research topics, architectural overview, code flow across multiple files, consolidating data from multiple sources, compare specs with implementation",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                subagent: {
                    "*": "deny",
                    "query*": "allow",
                },
            },
            prompt: buildResearchPrompt,
            temperature: 0.7,
            tier: "smart",
        },

        "auto-review-api": {
            color: colorAutonomousOrchestrator,
            description: "Use auto-review-api subagent to review API changes: check endpoints, run tests, fix failures, and confirm API requirements are met",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                autocode_sandbox_create: "allow",
                autocode_sandbox_delete: "allow",
                subagent: {
                    "*": "deny",
                    "execute-code": "allow",
                    "execute-sandbox": "allow",
                    "execute-script": "allow",
                    "execute-os": "allow",
                    "execute-rest": "allow",
                    "query-code": "allow",
                    "query-git": "allow",
                    "query-text": "allow",
                },
            },
            prompt: buildReviewApiPrompt,
            temperature: 0.3,
            tier: "smart",
        },

        "auto-review-ui": {
            color: colorAutonomousOrchestrator,
            description: "Use auto-review-ui subagent to review UI changes: run application, inspect UI, run tests, and confirm UI requirements are met",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                autocode_sandbox_create: "allow",
                autocode_sandbox_delete: "allow",
                subagent: {
                    "*": "deny",
                    "execute-code": "allow",
                    "execute-sandbox": "allow",
                    "execute-script": "allow",
                    "execute-os": "allow",
                    "query-browser": "allow",
                    "query-code": "allow",
                    "query-git": "allow",
                    "query-text": "allow",
                },
            },
            prompt: buildReviewUiPrompt,
            temperature: 0.3,
            tier: "smart",
        },

        "auto-test": {
            color: colorAutonomousOrchestrator,
            description: "Use auto-test subagent to write, run or fix tests.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                edit: "allow",
                skill: {
                    "*": "deny",
                    "test*": "allow",
                },
                subagent: {
                    "*": "deny",
                    "execute-code": "allow",
                    "execute-config": "allow",
                    "execute-script": "allow",
                    "execute-os": "allow",
                    "query-code": "allow",
                    "query-config": "allow",
                    "query-git": "allow",
                },
            },
            prompt: buildTestPrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        "auto-troubleshoot": {
            color: colorAutonomousOrchestrator,
            description: "Use auto-troubleshoot subagent to troubleshoot obstacles, bugs and issues.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                autocode_sandbox_create: "allow",
                autocode_sandbox_delete: "allow",
                "context7*": "allow",
                skill: {
                    "*": "deny",
                    "skill-write": "allow",
                },
                learn: "allow",
                autocode_memory_recall: "allow",
                autocode_memory_forget: "allow",
                subagent: {
                    "*": "deny",
                    "execute-code": "allow",
                    "execute-config": "allow",
                    "execute-debug": "allow",
                    "execute-rest": "allow",
                    "execute-sandbox": "allow",
                    "execute-script": "allow",
                    "execute-os": "allow",
                    "execute-ssh": "allow",
                    "query*": "allow",
                },
                "todo*": "allow",
            },
            prompt: buildTroubleshootPrompt,
            temperature: 0.5,
            tier: "smart",
        },

        // Document Workers

        "document-agents": {
            color: colorDocumentWorker,
            description: "Use document-agents subagent to convert latest `README.md` to `AGENTS.md`.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_md_create": "allow",
                "autocode_md_h1": "allow",
                "autocode_md_read": "allow",
                "autocode_md_update": "allow",
                skill: {
                    "*": "deny",
                    "author-rules": "allow"
                }
            },
            prompt: documentAgentsPrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        "document-conventions": {
            color: colorDocumentWorker,
            description: "Use document-conventions subagent to document naming conventions and project terminology.",
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
                    "skill-write": "allow"
                },
                skill_edit: "allow",
            },
            prompt: documentConventionsPrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        "document-code": {
            color: colorDocumentWorker,
            description: "Use document-code subagent to document technical architecture and design decisions or source code/config locations.",
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
                    "skill-write": "allow"
                },
                skill_edit: "allow",
            },
            prompt: documentCodePrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        "document-env": {
            color: colorDocumentWorker,
            description: "Use document-env subagent to document related project to current project.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_config_read": "allow",
                grep: "allow",
                read: "allow",
                skill: {
                    "*": "deny",
                    "skill-write": "allow",
                },
                skill_edit: "allow",
                learn: "allow",
                subagent: {
                    "*": "deny",
                    "query-os": "allow",
                    "query-ssh": "allow"
                }
            },
            prompt: documentEnvPrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        "document-install": {
            color: colorDocumentWorker,
            description: "Use document-install subagent to document project installation and usage guide.",
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
                    "skill-write": "allow"
                },
                skill_edit: "allow",
            },
            prompt: documentInstallPrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        "document-prd": {
            color: colorDocumentWorker,
            description: "Use document-prd subagent to document product requirements and user roles.",
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
                    "skill-write": "allow"
                },
                skill_edit: "allow",
            },
            prompt: String(documentPrdPrompt),
            temperature: 0.3,
            tier: "balanced",
        },

        "document-ux": {
            color: colorDocumentWorker,
            description: "Use document-ux subagent to document UX flows, navigation, and styling patterns",
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
                    "skill-write": "allow"
                },
                skill_edit: "allow",
            },
            prompt: documentUxPrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        // Execute workers

        "execute-author": {
            color: colorWritableWorker,
            description: "Use execute-author subagent to create/edit/review/revise md (Markdown) content (like articles, documents, faqs, tutorials); It NEVER edit source code, program scripts or system config; NEVER review md content yourself.",
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_md_*": "allow",
                skill: {
                    "*": "deny",
                    "author*": "allow",
                },
            },
            prompt: executeAuthorPrompt,
            temperature: 0.5,
            tier: "balanced",
        },

        "execute-code": {
            color: colorWritableWorker,
            description: "Use execute-code subagent to update the codebase with code, permanent project scripts, config, and templates; NEVER write md files; NEVER run shell/tsc/tests/code/scripts; Include pseudocode/algorithms, scope, identifiers, parameters, types, styling, content, error handling, parameter validation details in prompt.",
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
                    "angular-developer": "allow",
                    "code*": "allow",
                    "design*": "allow",
                    "java-junit": "allow",
                    "javascript-typescript-jest": "allow",
                    "nitro": "allow",
                    "nuxt": "allow",
                    "tailwindcss": "allow",
                    "vitest": "allow"
                },
            },
            prompt: executeCodePrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        "execute-config": {
            color: colorWritableWorker,
            description: "Use execute-config subagent to create or update configs or data files: Support only .conf, .ini, .properties, .json, .jsonc, yaml, yml; It NEVER edit source code.",
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_config_*": "allow",
            },
            prompt: executeConfigPrompt,
            temperature: 0.1,
            tier: "operator",
        },

        "execute-debug": {
            color: colorWritableWorker,
            description: "Use execute-debug subagent to debug code flow leading to symptoms of reproducible bug as evidence of cause; Prompt must include bug symptoms and bug reproduction steps.",
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_config_*": "allow",
                autocode_process_kill: "allow",
                doom_loop: "deny",
                edit: "allow",
                glob: "allow",
                grep: "allow",
                lsp: "allow",
                "pty*": "allow",
                read: "allow",
                shell: "allow",
                skill: {
                    "*": "deny",
                    "skill-write": "allow"
                },
                learn: "allow",
            },
            prompt: executeDebugPrompt,
            temperature: 0.6,
            tier: "balanced",
        },

        "execute-document": {
            color: colorDocumentWorker,
            description: "Use execute-document subagent to update `AGENTS.md`, `README.md`, skills, remember architectural/design decisions or specs.",
            mode: "subagent",
            permission: {
                "*": "deny",
                autocode_logo_find: "allow",
                "autocode_md_*": "allow",
                skill: {
                    "*": "deny",
                    "author-readme": "allow",
                },
                subagent: {
                    "*": "deny",
                    "document-*": "allow"
                },
            },
            prompt: executeDocumentPrompt,
            temperature: 0.1,
            tier: "balanced",
        },

        "execute-excel": {
            color: colorWritableWorker,
            description: "Use execute-excel subagent with excel related tasks like workbook manipulations and data validation.",
            mode: "subagent",
            permission: {
                "*": "deny",
                edit: "allow",
                "excel_*": "allow",
                read: "allow",
                subagent: {
                    "*": "deny",
                    "query-excel": "allow",
                    "query-text": "allow"
                },
                "todo*": "allow",
            },
            prompt: executeExcelPrompt,
            temperature: 0.3,
            tier: "operator",
        },

        "execute-opencode": {
            color: colorWritableWorker,
            description: "Use execute-opencode subagent to create or update OpenCode agent, command, skill and AGENTS.md files only.",
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_config_*": "allow",
                "autocode_md_*": "allow",
                skill: {
                    "*": "deny",
                    "skill-write": "allow",
                    "author-agent": "allow",
                    "author-command": "allow",
                    "author-rules": "allow",
                    "customize-opencode": "allow" // Build-in to OpenCode
                },
                skill_edit: "allow",
            },
            prompt: executeOpencodePrompt,
            temperature: 0.3,
            tier: "operator",
        },

        "execute-os": {
            color: colorWritableWorker,
            description: "Use execute-os subagent to copy/move/delete/permission files, start/stop apps/services, run scripts/commands/tests. NOT for source code editing!",
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_config_*": "allow",
                autocode_dependencies: "allow",
                autocode_process_kill: "allow",
                edit: "allow",
                external_directory: "allow",
                "filesystem*": "allow",
                glob: "allow",
                grep: "allow",
                "pty*": "allow",
                read: "allow",
                shell: "allow",
                skill: {
                    "*": "deny",
                    "angular-new-app": "allow",
                    "execute-install": "allow",
                    "execute-sandbox": "allow",
                },
                learn: "allow",
            },
            prompt: buildExecuteOsPrompt(capabilities),
            temperature: 0.1,
            tier: "balanced",
        },

        "execute-rest": {
            color: colorReadOnlyWorker,
            description: "Use execute-rest subagent to make REST/API requests on HTTP/HTTPS endpoints. Useful to reproduce API-related issues.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                autocode_config_read: "allow",
                autocode_rest: "allow",
                grep: "allow",
                learn: "allow",
                read: "allow",
            },
            prompt: executeRestPrompt,
            temperature: 0.1,
            tier: "operator",
        },

        "execute-sandbox": {
            color: colorWritableWorker,
            description: "Use execute-sandbox subagent to execute CLI commands in sandbox environment; First create sandbox with `autocode_sandbox_create`, then you run multiple `execute-sandbox` tasks but you MUST include same `sandbox_name` in every `task` prompt",
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
                    "execute-install": "allow",
                    "execute-sandbox": "allow",
                    "skill-write": "allow"
                },
                learn: "allow",
                "todo*": "allow",
            },
            prompt: buildExecuteOsPrompt(sandboxLinuxCapabilities),
            temperature: 0.1,
            tier: "operator",
        },

        "execute-script": {
            color: colorWritableWorker,
            description: "Use execute-script subagent to execute repetitive actions, data/document/media conversions, generate/render content, or control external apps via *temporary* scripts like 'for each X file in Y do Z' or 'convert all A files to B' or 'generate X with Z' or 'use app A's output to invoke app B'; NOT for *permanent* project scripts",
            mode: "subagent",
            permission: {
                "*": "deny",
                autocode_script_install: "allow",
                autocode_script_project: "allow",
                autocode_script_run: "allow",
                autocode_script_service: "allow",
                edit: "allow",
                glob: "allow",
                grep: "allow",
                learn: "allow",
                read: "allow",
                skill: {
                    "*": "deny",
                    "execute-install": "allow"
                },
                write: "allow",
            },
            prompt: executeScriptPrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        "execute-ssh": {
            color: colorWritableWorker,
            description: "Use execute-ssh subagent to access remote SSH/SFTP servers to execute remote commands or search/read/write remote files.",
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_ssh*": "allow",
                skill: {
                    "*": "deny",
                    "execute-install": "allow"
                },
                learn: "allow",
                "todo*": "allow",
            },
            prompt: executeSshPrompt,
            temperature: 0.1,
            tier: "balanced",
        },

        // Query workers

        "query-autocode": {
            color: colorReadOnlyWorker,
            description: "Use query-autocode subagent for OpenCode or AutoCode documentation or configuration related queries or advise.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_config_read": "allow",
                "autocode_md_read": "allow",
                "autocode_md_frontmatter_read": "allow",
                "open_websearch*": "allow",
                skill: {
                    "*": "deny",
                    "author-agent": "allow",
                    "author-command": "allow",
                    "skill-write": "allow",
                },
                webfetch: "allow",
                "websearch*": "allow",
            },
            prompt: queryAutocodePrompt,
            temperature: 0.1,
            tier: "fast",
        },

        "query-browser": {
            color: colorReadOnlyWorker,
            description: "Use query-browser subagent to inspect or investigate UI of YOUR RUNNING APPLICATION in real browser (first start app before tasking query-browser) or to pair with user (you drive, user manual login and solve captchas) to access restricted online sources. Ask query-browser to debug, find DOM elements, summarize console logs, analyze network requests, interact with UI elements, monitor performance, test frontend functionality like human. NOT for internet searches.",
            hidden: true,
            mode: "subagent",
            permission: {
                '*': "deny",
                "chrome*": "allow",
                skill: {
                    "*": "deny",
                    "execute-ux": "allow",
                },
            },
            prompt: queryBrowserPrompt,
            tier: "fast",
        },

        "query-code": {
            color: colorReadOnlyWorker,
            description: "Use query-code subagent to find, summarize, understand: source code, scripts or codebase; NEVER query md, template, styling, config, data files; NEVER to return full file content",
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
            },
            prompt: queryCodePrompt,
            temperature: 0.3,
            tier: "context",
        },

        "query-config": {
            color: colorReadOnlyWorker,
            description: "Use query-config subagent to read config or data file values or outlines: Support only .conf, .ini, .properties, .json, .jsonc, yaml, yml; No other file types supported.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                autocode_config_read: "allow",
            },
            prompt: queryConfigPrompt,
            temperature: 0.1,
            tier: "fast",
        },

        "query-db": {
            color: colorReadOnlyWorker,
            description: "Use query-db subagent to inspect environment-configured databases in read-only mode using Autocode DB tools",
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
            tier: "context",
        },

        "query-excel": {
            color: colorReadOnlyWorker,
            description: "Use query-excel subagent to read excel files.",
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
            tier: "context",
        },

        "query-git": {
            color: colorReadOnlyWorker,
            description: "Use query-git subagent to inspect Git repos (status, diff, log, show), recent project file changes, file history.",
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

        "query-os": {
            color: colorReadOnlyWorker,
            description: "Use query-os subagent to find OS provided info like: local host hardware, software, system, network, service, process, versions, help-command info, status.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_config_read": "allow",
                "autocode_md_frontmatter_read": "allow",
                doom_loop: "deny",
                external_directory: "allow",
                glob: "allow",
                grep: "allow",
                learn: "allow",
                lsp: "allow",
                read: "allow",
                shell: "allow",
            },
            prompt: buildQueryOsPrompt(capabilities),
            temperature: 0.1,
            tier: "fast",
        },

        "query-skills": {
            color: colorReadOnlyWorker,
            description: "Use query-skills subagent to ask questions about project architecture / design / PRD / conventions / technologies / documentation or development environment / user preferences / dangerous operations / how previous mistakes were corrected.",
            hidden: true,
            mode: "subagent",
            permission: {
                '*': "deny",
                skill: {
                    "*": "deny",
                    "customize-opencode": "allow", // Build-in to OpenCode
                    "design*": "allow",
                    "execute*": "allow",
                    "vue-best-practices": "allow",
                    "ui-craft": "allow",
                },
                "todo*": "allow"
            },
            prompt: querySkillsPrompt,
            tier: "fast",
        },

        "query-ssh": {
            color: colorReadOnlyWorker,
            description: "Use query-ssh subagent to find on remote SSH/SFTP servers: files, configuration, process status, etc.",
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
                learn: "allow",
            },
            prompt: querySshPrompt,
            temperature: 0.1,
            tier: "fast",
        },

        "query-text": {
            color: colorReadOnlyWorker,
            description: "Use query-text subagent to answer questions (presence?, contains?, outline?, fallacies?, debatable claims?, arguments?) or to evaluate/criticize textual content: md content, md front-matter, articles/document sections, styling, templates, assets, resources; NEVER to return full file content.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                "author-*": "allow",
                "autocode_config_read": "allow",
                "autocode_md_frontmatter_read": "allow",
                "autocode_md_read": "allow",
                glob: "allow",
                grep: "allow",
                read: "allow"
            },
            prompt: queryTextPrompt,
            temperature: 0.1,
            tier: "context",
        },

        "query-web": {
            color: colorReadOnlyWorker,
            description: "Use query-web subagent to search and read public ONLINE web sources: documentation, articles, forums, GitHub, news, framework API/SDKs, public repo examples; Allow ONLY 1 query per subagent session.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                "context7*": "allow",
                "open_websearch*": "allow",
                "todo*": "allow",
                webfetch: "allow",
                "websearch*": "allow",
            },
            prompt: queryWebPrompt,
            temperature: 0.5,
            tier: "context",
        },

        "query-youtube": {
            color: colorReadOnlyWorker,
            description: "Use query-youtube subagent to transcribe YouTube videos.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                autocode_youtube_transcribe: "allow",
            },
            prompt: queryYoutubePrompt,
            temperature: 0.1,
            tier: "context",
        },

    }
}

function hasAskCapableQuestionPermission(permission: LegacyAgentConfig["permission"]): boolean {
    if (!permission || typeof permission === "string") {
        return false
    }

    return permission.question === "ask" || permission.question === "allow"
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
        return { "*": "ask" }
    }

    const rules: Record<string, PermissionAction> = {}
    for (const [pattern, action] of Object.entries(source as Record<string, unknown>)) {
        if (isPermissionAction(action)) {
            rules[pattern] = normalizePermissionAction(action, canAsk)
        }
    }

    return { "*": "ask", ...rules }
}

function applyExternalDirectoryOverrides(
    rules: Record<string, PermissionAction>,
    externalDirectories: ExternalDirectoryRules | PermissionRule[],
    canAsk: boolean,
    explicitFallback = false,
    source?: unknown,
): Record<string, PermissionAction> | PermissionRule[] {
    if (Array.isArray(externalDirectories)) {
        const agentRules = source && typeof source === "object" && !Array.isArray(source)
            ? Object.entries(source).filter((entry): entry is [string, PermissionAction] => isPermissionAction(entry[1]))
                .map(([resource, effect]) => ({ action: "external_directory", resource, effect: normalizePermissionAction(effect, canAsk) }))
            : Object.entries(rules).filter(([pattern, action]) => pattern !== "*" || action !== "ask" || explicitFallback)
                .map(([resource, effect]) => ({ action: "external_directory", resource, effect }))
        return [
            { action: "external_directory", resource: "*", effect: "ask" },
            ...externalDirectories.map((rule) => ({ ...rule, effect: normalizePermissionAction(rule.effect, canAsk) })),
            ...agentRules,
        ]
    }
    const { "*": fallback = "ask", ...exceptions } = rules
    return {
        "*": fallback,
        ...Object.fromEntries(Object.entries(externalDirectories as ExternalDirectoryRules).map(([pattern, action]) => [
            pattern,
            normalizePermissionAction(action, canAsk),
        ])),
        ...exceptions,
    }
}

function hasPermissionRule(permission: PermissionObject, key: string): boolean {
    return  Object.hasOwn(permission, key)
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
    externalDirectories: ExternalDirectoryRules | PermissionRule[] = {},
): AgentMap {
    return Object.fromEntries(Object.entries(agents).map(([agentName, agent]) => {
        if (!agent.permission || typeof agent.permission === "string") {
            return [agentName, agent]
        }

        const canAsk = hasAskCapableQuestionPermission(agent.permission)
        const permission: PermissionObject = { ...agent.permission }
        const externalDirectorySource = permission.external_directory

        const orderedExternalDirectories: ExternalDirectoryRules | PermissionRule[] = externalDirectorySource === "deny" && !Array.isArray(externalDirectories)
            ? Object.entries(externalDirectories).map(([resource, effect]) => ({ action: "external_directory", resource, effect }))
            : externalDirectories
        permission.external_directory = applyExternalDirectoryOverrides(
            createExternalPermissionRules(externalDirectorySource, canAsk),
            orderedExternalDirectories,
            canAsk,
            (isPermissionAction(externalDirectorySource) && externalDirectorySource !== "ask") || (typeof externalDirectorySource === "object"
                && externalDirectorySource !== null && Object.hasOwn(externalDirectorySource, "*")),
            externalDirectorySource,
        )

        return [agentName, { ...agent, permission }]
    }))
}

export function applySandboxPlatformPolicy(agents: AgentMap, options: SandboxPlatformPolicyOptions = {}): AgentMap {
    if (isSandboxPlatformSupported(normalizeSandboxPlatformPolicyOptions(options))) return agents

    return Object.fromEntries(Object.entries(agents).map(([agentName, agent]) => {
        const agentWithDisable = agentName === "execute-sandbox" ? { ...agent, disable: true } : agent
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

export function applyWindowsSandboxPolicy(agents: AgentMap, capabilities: PlatformCapabilities): AgentMap {
    if (!capabilities.isWindows) return agents

    return Object.fromEntries(Object.entries(agents)
        .filter(([agentName]) => agentName !== "execute-sandbox")
        .map(([agentName, agent]) => [agentName, removeWindowsSandboxReferences(agent)]))
}

function removeWindowsSandboxReferences(agent: LegacyAgentConfig): LegacyAgentConfig {
    const permission = agent.permission
    const description = typeof agent.description === "string" ? removeWindowsSandboxPromptGuidance(agent.description) : agent.description
    const prompt = typeof agent.prompt === "string" ? removeWindowsSandboxPromptGuidance(agent.prompt) : agent.prompt

    return {
        ...agent,
        description,
        permission: permission && typeof permission !== "string"
            ? removeWindowsSandboxPermissionRules(permission)
            : permission,
        prompt,
    }
}

function removeWindowsSandboxPermissionRules(permission: PermissionObject): PermissionObject {
    return Object.fromEntries(Object.entries(permission).flatMap(([key, rule]) => {
        if (isSandboxReference(key)) return []
        return [[key, removeWindowsSandboxPermissionRule(rule)] as const]
    })) as PermissionObject
}

function removeWindowsSandboxPermissionRule(
    rule: AutocodePermissionRule | AutocodeTaskPermissionRules | undefined,
): AutocodePermissionRule | AutocodeTaskPermissionRules | undefined {
    if (rule === undefined || typeof rule === "string") return rule

    return Object.fromEntries(Object.entries(rule).flatMap(([key, nestedRule]) => {
        if (isSandboxReference(key)) return []
        return [[key, removeWindowsSandboxPermissionRule(nestedRule)] as const]
    })) as PermissionTargetRules | AutocodeTaskPermissionRules
}

function removeWindowsSandboxPromptGuidance(prompt: string): string {
    return prompt.split("\n").filter((line) => !isSandboxReference(line)).join("\n")
}

function isSandboxReference(value: string): boolean {
    return value.toLowerCase().includes("sandbox")
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
    externalDirectories: ExternalDirectoryRules | PermissionRule[],
    sandboxSupportOverride?: SandboxPlatformSupportOptions,
): AgentMap {
    return applySandboxPlatformPolicy(
        applyExternalDirectoryPolicy(agents, externalDirectories),
        sandboxSupportOverride ?? {},
    )
}

function applyManagedAgentTierRegistration(
    agents: AgentMap,
    tiers: Partial<Record<ModelTier, TierConfig>>,
): AgentMap {
    return Object.fromEntries(Object.entries(agents).filter(([agentName]) => {
        if (agentName === "spy") return tiers.spy !== undefined
        if (agentName === "auto") return tiers.smart !== undefined
        return true
    }))
}

export function injectExternalSkillPermissions(agents: AgentMap, externalSkills: ExternalSkill[]): void {
    const granted = new Set<string>()
    for (const { category, skillName } of externalSkills) {
        const targetAgentNames = CATEGORY_AGENTS[category]
        if (targetAgentNames === undefined) {
            continue
        }

        for (const agentName of targetAgentNames) {
            const grantKey = `${agentName}\0${skillName}`
            if (granted.has(grantKey)) continue
            granted.add(grantKey)
            const agent = agents[agentName]
            if (agent === undefined) {
                continue
            }

            agent.permission = agent.permission ?? {}
            const permission = agent.permission
            if (typeof permission !== "string") {
                if (typeof permission.skill === "string" || permission.skill === undefined) {
                    permission.skill = { [skillName]: "allow" }
                } else {
                    permission.skill = { ...permission.skill, [skillName]: "allow" }
                }
            }
        }
    }
}

export function buildAgents(
    capabilities: PlatformCapabilities,
    externalDirectories: ExternalDirectoryRules | PermissionRule[] = {},
    sandboxSupportOverride?: SandboxPlatformSupportOptions,
    externalSkills: ExternalSkill[] = [],
    tiers: Partial<Record<ModelTier, TierConfig>> = {},
): V2AgentMap {
    const agents = applyManagedAgentTierRegistration(
        applyBundledAgentPolicy(createBaseAgents(capabilities), externalDirectories, sandboxSupportOverride),
        tiers,
    )
    injectExternalSkillPermissions(agents, externalSkills)
    return Object.fromEntries(Object.entries(applyWindowsSandboxPolicy(agents, capabilities)).map(([name, agent]) => {
        const { permission, ...definition } = agent
        return [name, { ...definition, permissions: toV2Permissions(permission) }]
    }))
}

export function toV2Permissions(permission: LegacyAgentConfig["permission"]): PermissionRule[] {
    if (isPermissionAction(permission)) return permission === "deny"
        ? [{ action: "*", resource: "*", effect: "deny" }]
        : [
            { action: "*", resource: "*", effect: permission },
            { action: "external_directory", resource: "*", effect: "ask" },
        ]
    if (!permission) return [{ action: "external_directory", resource: "*", effect: "ask" }]
    const result: PermissionRule[] = []
    for (const [name, value] of Object.entries(permission)) {
        if (name === "doom_loop") continue
        const action = name === "task" ? "subagent" : name === "bash" ? "shell" : name === "write" || name === "patch" ? "edit" : name
        if (isPermissionAction(value)) result.push({ action, resource: "*", effect: value })
        else if (Array.isArray(value) && name === "external_directory") result.push(...value)
        else if (value && typeof value === "object") {
            for (const [resource, effect] of Object.entries(value)) {
                if (isPermissionAction(effect)) result.push({ action, resource, effect })
            }
        }
    }
    if (!result.some((rule) => rule.action === "external_directory" && rule.resource === "*")) {
        const firstExternalRule = result.findIndex((rule) => rule.action === "external_directory")
        const fallbackIndex = result.findIndex((rule) => rule.action === "*" && rule.resource === "*") + 1
        result.splice(firstExternalRule < 0 ? fallbackIndex : Math.max(fallbackIndex, firstExternalRule), 0,
            { action: "external_directory", resource: "*", effect: "ask" })
    }
    return result
}

export function getAgentPermission(
    agentName: string,
    capabilities: PlatformCapabilities,
    externalDirectories: ExternalDirectoryRules | PermissionRule[] = {},
): AutocodeAgentConfig["permissions"] {
    return buildAgents(capabilities, externalDirectories)[agentName]?.permissions
}

export function getAgentTier(agentName: string): ModelTier | undefined {
    return createBaseAgents({ isWindows: false })[agentName]?.tier
}
