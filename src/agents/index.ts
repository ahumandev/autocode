import type { AgentConfig } from "@opencode-ai/sdk/v2"
import type { ExternalDirectoryRules, ModelTier, PermissionAction, SkillCategory, TierConfig } from "@/config"
import type { PlatformCapabilities } from "@/utils/platform"
import type { ExternalSkill } from "../utils/external"
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

type PermissionTargetRules = Record<string, PermissionAction>
type AutocodePermissionRule = PermissionAction | PermissionTargetRules
type AutocodeTaskPermissionRules = Record<string, AutocodePermissionRule>
type AutocodePermissionObject = {
    task?: PermissionAction | AutocodeTaskPermissionRules
    skill?: PermissionAction | Record<string, PermissionAction>
    [key: string]: AutocodePermissionRule | AutocodeTaskPermissionRules | undefined
}
export type AutocodeAgentConfig = Omit<AgentConfig, "permission"> & { permission?: PermissionAction | AutocodePermissionObject, tier?: ModelTier }
type AgentMap = Record<string, AutocodeAgentConfig>
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
            description: "💡 Advise how to manually fix problems.",
            hidden: false,
            mode: "primary",
            permission: {
                "*": "deny",
                autocode_config_read: "allow",
                autocode_md_frontmatter_read: "allow",
                autocode_md_read: "allow",
                autocode_session_create: "allow",
                doom_loop: "ask",
                git_commit: "ask",
                question: "allow",
                skill: {
                    "*": "deny",
                    "assist-*": "allow",
                    "author-*": "allow",
                    "codebase-design": "allow", // From mattpocock/skills
                    "git-commit": "allow",
                    "learned-preferences*": "allow",
                    "primary-manual*": "allow",
                    "skill-write": "allow",
                    "ui-craft": "allow",
                },
                skill_learn: "allow",
                task: {
                    "*": "deny",
                    "auto-research": "allow",
                    "query*": "allow",
                },
                task_resume: "allow",
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
                autocode_sandbox_create: "ask",
                autocode_sandbox_delete: "allow",
                autocode_session_create: "allow",
                doom_loop: "ask",
                edit: "allow",
                git_commit: "allow",
                question: "allow",
                skill: {
                    "*": "deny",
                    "assist-*": "allow",
                    "author-*": "allow",
                    "codebase-design": "allow", // From mattpocock/skills
                    "git-commit": "allow",
                    "learned-preferences*": "allow",
                    "learned-permissions*": "allow",
                    "primary-manual*": "allow",
                    "skill-write": "allow",
                    "ui-craft": "allow",
                },
                skill_edit: "allow",
                skill_learn: "allow",
                task: {
                    "*": "allow",
                    "auto*": "deny",
                    "auto-research": "allow",
                    build: "deny",
                    "document*": "deny",
                    plan: "deny",
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
                    "learned-permissions*": "allow",
                    "learned-preferences*": "allow",
                    "primary-manual": "allow"
                },
                skill_learn: "allow",
                task: {
                    "*": "deny",
                    "auto-*": "allow",
                    "query-*": "allow"
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
            description: "📐 Design and propose solutions.",
            hidden: false,
            mode: "primary",
            permission: {
                "*": "deny",
                autocode_agent_execute: "allow",
                autocode_concept_create: "allow",
                autocode_concept_list: "allow",
                autocode_concept_read: "allow",
                autocode_job_execute: "allow",
                autocode_job_list: "allow",
                autocode_session_create: "allow",
                doom_loop: "ask",
                external_directory: "ask",
                question: "allow",
                skill: {
                    "*": "deny",
                    "codebase-design": "allow", // From mattpocock/skills
                    "learned-preferences*": "allow",
                    "skill-write": "allow",
                },
                skill_learn: "allow",
                task: {
                    "*": "deny",
                    "auto-research": "allow",
                    "query*": "allow",
                },
                task_external: "ask",
                task_resume: "allow",
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
                autocode_session_create: "allow",
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
                question: "allow",
                read: "allow",
                skill: {
                    "*": "deny",
                    "learned-corrections*": "allow",
                    "learned-env*": "allow",
                    "learned-preferences*": "allow",
                },
                "todo*": "allow",
            },
            prompt: spyPrompt,
            tier: "spy",
        },

        // Secondary Orchestrators

        "assist-browser": {
            color: colorWritableInteractiveOrchestrator,
            description: "task assist-browser with interactive browser automation tasks. It browser than can: access that can fill forms, submit, save, upload, pair with user for manual steps like login, captcha, and 2FA. Browser state persists across calls via `task_id` so tab and login session are not re-discovered.",
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
                    "skill-write": "allow",
                },
                skill_learn: "allow",
                "todo*": "allow",
            },
            prompt: assistBrowserPrompt,
            temperature: 0.3,
            tier: "operator",
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
                task: {
                    "*": "deny",
                    "execute-code": "allow",
                    "execute-os": "allow",
                    query_architect: "allow",
                    "query-code": "allow",
                    "query-git": "allow",
                    "query-os": "allow",
                    "query-text": "allow"
                },
                task_resume: "allow",
                "todowrite": "allow",
            },
            prompt: assistGitConflictPrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        "auto-author": {
            color: colorAutonomousOrchestrator,
            description: "task auto-author to author or review: articles, docs, excel reports or agentic skills or prompts; NOT for config or source code comments.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_md_*": "allow",
                edit: "allow",
                skill: {
                    "*": "deny",
                    "learned-preferences*": "allow",
                    "skill-write": "allow",
                },
                task: {
                    "*": "deny",
                    "document-*": "allow",
                    "execute-author": "allow",
                    "execute-document": "allow",
                    "query-text": "allow",
                    "query-web": "allow",
                    "query-youtube": "allow",
                },
                task_resume: "allow",
            },
            prompt: autoAuthorPrompt,
            temperature: 0.7,
            tier: "smart",
        },

        "auto-design": {
            color: colorAutonomousOrchestrator,
            description: "task auto-design to redesign failed PROPOSALS when new unresolvable blocking CONSTRAINTS arise. Always try resolve OBSTACLES first with auto-troubleshoot. Only task auto-design as last resort when unresolvable root cause (new CONSTRAINT) is clear.",
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

        "auto-feature": {
            color: colorAutonomousOrchestrator,
            description: "task auto-feature to create new project features: Implement new API's, classes, components, css styles, packages, scripts, templates, webpages",
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
                    "learned-preferences*": "allow",
                    "vue-best-practices": "allow",
                    "ui-craft": "allow",
                },
                task: {
                    "*": "deny",
                    "auto-test": "allow",
                    "auto-troubleshoot": "allow",
                    "execute-code": "allow",
                    "execute-os": "allow",
                    "query-code": "allow",
                    "query-git": "allow",
                    "query-text": "allow"
                },
                task_resume: "allow",
                "todo*": "allow",
            },
            prompt: autoFeaturePrompt,
            temperature: 0.3,
            tier: "smart",
        },

        "auto-general": {
            color: colorAutonomousOrchestrator,
            description: "Only fallback to auto-general as last resort when no specialized subagent clearly fits task.",
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
                task: {
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
            description: "task auto-refactor to upgrade, migrate, or optimize code: improve security, performance, readability, efficiency, maintainability.",
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
                    "learned-preferences*": "allow"
                },
                task: {
                    "*": "deny",
                    "auto-troubleshoot": "allow",
                    "execute-code": "allow",
                    "execute-script": "allow",
                    "execute-os": "allow",
                    "query-code": "allow",
                    "query-git": "allow",
                },
                task_resume: "allow",
            },
            prompt: buildRefactorPrompt,
            temperature: 0.3,
            tier: "smart",
        },

        "auto-research": {
            color: colorAutonomousOrchestrator,
            description: "task auto-research to answer complex questions like research topics, architectural overview, code flow across multiple files, consolidating data from multiple sources, compare specs with implementation",
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
                    "execute-code": "allow",
                    "execute-sandbox": "allow",
                    "execute-script": "allow",
                    "execute-os": "allow",
                    "execute-rest": "allow",
                    query_architect: "allow",
                    "query-code": "allow",
                    "query-git": "allow",
                    "query-text": "allow",
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
                    "execute-code": "allow",
                    "execute-sandbox": "allow",
                    "execute-script": "allow",
                    "execute-os": "allow",
                    query_architect: "allow",
                    "query-browser": "allow",
                    "query-code": "allow",
                    "query-git": "allow",
                    "query-text": "allow",
                },
                task_resume: "allow",
            },
            prompt: buildReviewUiPrompt,
            temperature: 0.3,
            tier: "smart",
        },

        "auto-test": {
            color: colorAutonomousOrchestrator,
            description: "task auto-test to write, run or fix tests.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                edit: "allow",
                skill: {
                    "*": "deny",
                    "test*": "allow",
                    "learned-corrections*": "allow",
                },
                task: {
                    "*": "deny",
                    "execute-code": "allow",
                    "execute-config": "allow",
                    "execute-script": "allow",
                    "execute-os": "allow",
                    "query-code": "allow",
                    "query-config": "allow",
                    "query-git": "allow",
                },
                task_resume: "allow",
            },
            prompt: buildTestPrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        "auto-troubleshoot": {
            color: colorAutonomousOrchestrator,
            description: "task auto-troubleshoot to troubleshoot obstacles, bugs and issues.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                autocode_sandbox_create: "allow",
                autocode_sandbox_delete: "allow",
                "context7*": "allow",
                skill: {
                    "*": "deny",
                    "learned-corrections*": "allow",
                    "learned-env*": "allow",
                    "skill-write": "allow",
                },
                skill_learn: "allow",
                task: {
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
                task_resume: "allow",
                "todo*": "allow",
            },
            prompt: buildTroubleshootPrompt,
            temperature: 0.5,
            tier: "smart",
        },

        // Document Workers

        "document-agents": {
            color: colorDocumentWorker,
            description: "task document-agents to convert latest `README.md` to `AGENTS.md`.",
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
            description: "task document-conventions to document naming conventions and project terminology.",
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
            description: "task document-code to document technical architecture and design decisions or source code/config locations.",
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
            description: "task document-env to document related project to current project.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_config_read": "allow",
                grep: "allow",
                read: "allow",
                skill: {
                    "*": "deny",
                    "learned-env*": "allow",
                    "skill-write": "allow",
                },
                skill_edit: "allow",
                skill_learn: "allow",
                task: {
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
            description: "task document-install to document project installation and usage guide.",
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
            description: "task document-prd to document product requirements and user roles.",
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
            description: "task document-ux to document UX flows, navigation, and styling patterns",
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
            description: "task execute-author to create/edit/review/revise md (Markdown) content (like articles, documents, faqs, tutorials); It NEVER edit source code, program scripts or system config; NEVER review md content yourself.",
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
            description: "task execute-code to update the codebase with code, permanent project scripts, config, and templates; NEVER write md files; NEVER run bash/tsc/tests/code/scripts; Include pseudocode/algorithms, scope, identifiers, parameters, types, styling, content, error handling, parameter validation details in prompt.",
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
                    "learned-preferences*": "allow",
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
            description: "task execute-config to create or update configs or data files: Support only .conf, .ini, .properties, .json, .jsonc, yaml, yml; It NEVER edit source code.",
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
            description: "task execute-debug to debug code flow leading to symptoms of reproducible bug as evidence of cause; Prompt must include bug symptoms and bug reproduction steps.",
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_config_*": "allow",
                autocode_process_kill: "allow",
                bash: "allow",
                doom_loop: "deny",
                edit: "allow",
                glob: "allow",
                grep: "allow",
                lsp: "allow",
                "pty*": "allow",
                read: "allow",
                skill: {
                    "*": "deny",
                    "learned-corrections*": "allow",
                    "learned-env*": "allow",
                    "learned-permissions*": "allow",
                    "skill-write": "allow"
                },
                skill_learn: "allow",
            },
            prompt: executeDebugPrompt,
            temperature: 0.6,
            tier: "balanced",
        },

        "execute-document": {
            color: colorDocumentWorker,
            description: "task execute-document to update `AGENTS.md`, `README.md`, skills, remember architectural/design decisions or specs.",
            mode: "subagent",
            permission: {
                "*": "deny",
                autocode_logo_find: "allow",
                "autocode_md_*": "allow",
                skill: {
                    "*": "deny",
                    "author-readme": "allow",
                },
                task: {
                    "*": "deny",
                    "document-*": "allow"
                },
                task_resume: "allow"
            },
            prompt: executeDocumentPrompt,
            temperature: 0.1,
            tier: "balanced",
        },

        "execute-excel": {
            color: colorWritableWorker,
            description: "task execute-excel with excel related tasks like workbook manipulations and data validation.",
            mode: "subagent",
            permission: {
                "*": "deny",
                edit: "allow",
                "excel_*": "allow",
                read: "allow",
                task: {
                    "*": "deny",
                    "query-excel": "allow",
                    "query-text": "allow"
                },
                task_resume: "allow",
                "todo*": "allow",
            },
            prompt: executeExcelPrompt,
            temperature: 0.3,
            tier: "operator",
        },

        "execute-opencode": {
            color: colorWritableWorker,
            description: "task execute-opencode to create or update OpenCode agent, command, skill and AGENTS.md files only.",
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
            description: "task execute-os to copy/move/delete/permission files, start/stop apps/services, run scripts/commands/tests. NOT for source code editing!",
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_config_*": "allow",
                autocode_dependencies: "allow",
                autocode_process_kill: "allow",
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
                    "angular-new-app": "allow",
                    "execute-install": "allow",
                    "execute-sandbox": "allow",
                    "learned-corrections*": "allow",
                    "learned-env*": "allow",
                    "learned-permissions*": "allow",
                    "skill-write": "allow"
                },
                skill_learn: "allow",
            },
            prompt: buildExecuteOsPrompt(capabilities),
            temperature: 0.1,
            tier: "balanced",
        },

        "execute-rest": {
            color: colorReadOnlyWorker,
            description: "task execute-rest to make REST/API requests on HTTP/HTTPS endpoints. Useful to reproduce API-related issues.",
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
                    "learned-corrections*": "allow",
                    "learned-env*": "allow",
                    "skill-write": "allow"
                },
                skill_learn: "allow",
            },
            prompt: executeRestPrompt,
            temperature: 0.1,
            tier: "operator",
        },

        "execute-sandbox": {
            color: colorWritableWorker,
            description: "task execute-sandbox to execute CLI commands in sandbox environment; First create sandbox with `autocode_sandbox_create`, then you run multiple `execute-sandbox` tasks but you MUST include same `sandbox_name` in every `task` prompt",
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
                    "learned-corrections*": "allow",
                    "learned-env*": "allow",
                    "skill-write": "allow"
                },
                skill_learn: "allow",
                "todo*": "allow",
            },
            prompt: buildExecuteOsPrompt(sandboxLinuxCapabilities),
            temperature: 0.1,
            tier: "operator",
        },

        "execute-script": {
            color: colorWritableWorker,
            description: "task execute-script to execute repetitive actions, data/document/media conversions, generate/render content, or control external apps via *temporary* scripts like 'for each X file in Y do Z' or 'convert all A files to B' or 'generate X with Z' or 'use app A's output to invoke app B'; NOT for *permanent* project scripts",
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
                read: "allow",
                skill: {
                    "*": "deny",
                    "execute-install": "allow",
                    "learned-corrections*": "allow",
                    "learned-env*": "allow",
                    "learned-permissions*": "allow",
                    "skill-write": "allow"
                },
                skill_learn: "allow",
                write: "allow",
            },
            prompt: executeScriptPrompt,
            temperature: 0.3,
            tier: "balanced",
        },

        "execute-ssh": {
            color: colorWritableWorker,
            description: "task execute-ssh to access remote SSH/SFTP servers to execute remote commands or search/read/write remote files.",
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_ssh*": "allow",
                skill: {
                    "*": "deny",
                    "execute-install": "allow",
                    "learned-corrections*": "allow",
                    "learned-env-*": "allow",
                    "learned-permissions*": "allow",
                    "skill-write": "allow"
                },
                skill_learn: "allow",
                "todo*": "allow",
            },
            prompt: executeSshPrompt,
            temperature: 0.1,
            tier: "balanced",
        },

        // Query workers

        "query-autocode": {
            color: colorReadOnlyWorker,
            description: "task query-autocode for OpenCode or AutoCode documentation or configuration related queries or advise.",
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
            description: "task query-browser to inspect or investigate UI of YOUR RUNNING APPLICATION in real browser (first start app before tasking query-browser) or to pair with user (you drive, user manual login and solve captchas) to access restricted online sources. Ask query-browser to debug, find DOM elements, summarize console logs, analyze network requests, interact with UI elements, monitor performance, test frontend functionality like human. NOT for internet searches.",
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
            description: "task query-code to find, summarize, understand: source code, scripts or codebase; NEVER query md, template, styling, config, data files; NEVER to return full file content",
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
            description: "task query-config to read config or data file values or outlines: Support only .conf, .ini, .properties, .json, .jsonc, yaml, yml; No other file types supported.",
            hidden: true,
            mode: "subagent",
            permission: {
                "*": "deny",
                "autocode_config_*": "allow",
            },
            prompt: executeConfigPrompt,
            temperature: 0.1,
            tier: "fast",
        },

        "query-db": {
            color: colorReadOnlyWorker,
            description: "task query-db to inspect environment-configured databases in read-only mode using Autocode DB tools",
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
            description: "task query-excel to read excel files.",
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
            description: "task query-git to inspect Git repos (status, diff, log, show), recent project file changes, file history.",
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
            description: "task query-os to find OS provided info like: local host hardware, software, system, network, service, process, versions, help-command info, status.",
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
                    "learned-env*": "allow",
                    "learned-permissions*": "allow",
                    "skill-write": "allow",
                },
                skill_learn: "allow",
            },
            prompt: buildQueryOsPrompt(capabilities),
            temperature: 0.1,
            tier: "fast",
        },

        "query-skills": {
            color: colorReadOnlyWorker,
            description: "task query-skills to ask questions about project architecture / design / PRD / conventions / technologies / documentation or development environment / user preferences / dangerous operations / how previous mistakes were corrected.",
            hidden: true,
            mode: "subagent",
            permission: {
                '*': "deny",
                skill: {
                    "*": "deny",
                    "customize-opencode": "allow", // Build-in to OpenCode
                    "design*": "allow",
                    "execute*": "allow",
                    "learned-*": "allow",
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
            description: "task query-ssh to find on remote SSH/SFTP servers: files, configuration, process status, etc.",
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
                    "learned-env*": "allow",
                    "learned-permissions*": "allow",
                    "skill-write": "allow",
                },
                skill_learn: "allow",
            },
            prompt: querySshPrompt,
            temperature: 0.1,
            tier: "fast",
        },

        "query-text": {
            color: colorReadOnlyWorker,
            description: "task query-text to answer questions (presence?, contains?, outline?, fallacies?, debatable claims?, arguments?) or to evaluate/criticize textual content: md content, md front-matter, articles/document sections, styling, templates, assets, resources; NEVER to return full file content.",
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
            description: "task query-web to search and read public ONLINE web sources: documentation, articles, forums, GitHub, news, framework API/SDKs, public repo examples; Allow ONLY 1 query per subagent session.",
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
            tier: "context",
        },

        "query-youtube": {
            color: colorReadOnlyWorker,
            description: "task query-youtube to transcribe YouTube videos.",
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

function hasAskCapableQuestionPermission(permission: AutocodeAgentConfig["permission"]): boolean {
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

function removeWindowsSandboxReferences(agent: AutocodeAgentConfig): AutocodeAgentConfig {
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
    externalDirectories: ExternalDirectoryRules,
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
    externalDirectories: ExternalDirectoryRules = {},
    sandboxSupportOverride?: SandboxPlatformSupportOptions,
    externalSkills: ExternalSkill[] = [],
    tiers: Partial<Record<ModelTier, TierConfig>> = {},
): AgentMap {
    const agents = applyManagedAgentTierRegistration(
        applyBundledAgentPolicy(createBaseAgents(capabilities), externalDirectories, sandboxSupportOverride),
        tiers,
    )
    injectExternalSkillPermissions(agents, externalSkills)
    return applyWindowsSandboxPolicy(agents, capabilities)
}

export function getAgentPermission(
    agentName: string,
    capabilities: PlatformCapabilities,
    externalDirectories: ExternalDirectoryRules = {},
): AutocodeAgentConfig["permission"] {
    return buildAgents(capabilities, externalDirectories)[agentName]?.permission
}

export function getAgentTier(agentName: string): ModelTier | undefined {
    return createBaseAgents({ isWindows: false })[agentName]?.tier
}
