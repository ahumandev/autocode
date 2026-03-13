/**
 * Agent definitions for the Autocode plugin.
 *
 * Agents are registered programmatically via the `config` hook so they are
 * self-contained in the npm package — no Markdown files need to be copied or
 * referenced from the filesystem by the end user.
 *
 * The `.opencode/agent/` files in this repo are the LOCAL DEV equivalent —
 * opencode loads them from disk when running from the project root.
 * When deployed as a npm package, only this file is used.
 *
 * Prompts are stored in separate files under `./prompts/` for maintainability.
 */

import type { AgentConfig } from "@opencode-ai/sdk/v2"
import { askPrompt } from "./prompts/ask"
import { buildPrompt } from "./prompts/build"
import { documentPrompt } from "./prompts/document"
import { documentApiPrompt } from "./prompts/document/api"
import { documentAssetsPrompt } from "./prompts/document/assets"
import { documentCommonPrompt } from "./prompts/document/common"
import { documentDataPrompt } from "./prompts/document/data"
import { documentErrorPrompt } from "./prompts/document/error"
import { documentInstallPrompt } from "./prompts/document/install"
import { documentIntegrationsPrompt } from "./prompts/document/integrations"
import { documentNamingPrompt } from "./prompts/document/naming"
import { documentNavigationPrompt } from "./prompts/document/navigation"
import { documentReadmePrompt } from "./prompts/document/readme"
import { documentSecurityPrompt } from "./prompts/document/security"
import { documentStandardsPrompt } from "./prompts/document/standards"
import { documentStylePrompt } from "./prompts/document/style"
import { executePrompt } from "./prompts/execute";
import { modifyCodePrompt } from "./prompts/modify/code"
import { modifyExcelPrompt } from "./prompts/modify/excel"
import { modifyGitPrompt } from "./prompts/modify/git"
import { modifyMdPrompt } from "./prompts/modify/md"
import { modifyOsPrompt } from "./prompts/modify/os"
import { orchestratePrompt } from "./prompts/orchestrate"
import { orchestrateCoveragePrompt } from "./prompts/orchestrate/coverage"
import { orchestrateDocumentationPrompt } from "./prompts/orchestrate/documentation"
import { orchestrateExcelPrompt } from "./prompts/orchestrate/excel"
import { orchestrateFeaturePrompt } from "./prompts/orchestrate/feature"
import { orchestrateFormatPrompt } from "./prompts/orchestrate/format"
import { orchestrateGitCommitPrompt } from "./prompts/orchestrate/git_commit"
import { orchestrateQueryPrompt } from "./prompts/orchestrate/query"
import { orchestrateTroubleshootPrompt } from "./prompts/orchestrate/troubleshoot"
import { orchestrateReviewUiPrompt } from "./prompts/orchestrate/review_ui"
import { orchestrateReviewApiPrompt } from "./prompts/orchestrate/review_api"
import { planPrompt } from "./prompts/plan"
import { queryBrowserPrompt } from "./prompts/query/browser"
import { queryCodePrompt } from "./prompts/query/code"
import { queryExcelPrompt } from "./prompts/query/excel"
import { queryGitPrompt } from "./prompts/query/git"
import { queryTextPrompt } from "./prompts/query/text";
import { queryWebPrompt } from "./prompts/query/web"
import { testPrompt } from "./prompts/test"
import { troubleshootPrompt } from "./prompts/troubleshoot"

type AgentMap = Record<string, AgentConfig>

/**
 * COLOR MEANING:
 *
 * blue = planning
 * red = changing
 * green = testing
 * light = primary
 * dark = subagent
 */
export const agents: AgentMap = {

    ask: {
        color: "#40FFFF",
        description: "Generate reports (read-only)",
        mode: "primary",
        permission: {
            "*": "deny",
            question: "allow",
            task: {
                "*": "deny",
                "query*": "allow",
            },
            "todo*": "allow"
        },
        prompt: askPrompt
    },

    build: {
        color: "#FF4040",
        description: "Build autocode tasks from approved plans with ordered directories and prompt files",
        hidden: false, // "false" required by Plannotator
        mode: "primary",
        permission: {
            "*": "deny",
            "autocode_build*": "allow",
            doom_loop: "ask",
            plan_enter: "allow",
            question: "allow"
        },
        prompt: buildPrompt,
        temperature: 0.3
    },

    document: {
        color: "#8040FF",
        description: "Task `document` to keep project documentation up to date",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "allow",
            task: {
                "*": "deny",
                "document*": "allow",
                os: "allow",
            },
            "todo*": "allow",
        },
        prompt: documentPrompt,
        temperature: 0.1,
    },

    document_api: {
        color: "#402080",
        description: "Task `document_api` to document API endpoints",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            read: "allow",
        },
        prompt: documentApiPrompt,
        temperature: 0.3,
    },

    document_assets: {
        color: "#402080",
        description: "Task `document_assets` to document static assets in the project",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            read: "allow",
        },
        prompt: documentAssetsPrompt,
        temperature: 0.3,
    },

    document_common: {
        color: "#402080",
        description: "Task `document_common` to document common utilities and cross-cutting concerns",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            read: "allow",
        },
        prompt: documentCommonPrompt,
        temperature: 0.3,
    },

    document_data: {
        color: "#402080",
        description: "Task `document_data` to document data entities or persistence",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            read: "allow",
        },
        prompt: documentDataPrompt,
        temperature: 0.3,
    },

    document_error: {
        color: "#402080",
        description: "Task `document_error` to document error handling and logging",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            read: "allow",
        },
        prompt: documentErrorPrompt,
        temperature: 0.3,
    },

    document_install: {
        color: "#402080",
        description: "Task document_install to document project installation and usage guide",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            read: "allow",
        },
        prompt: documentInstallPrompt,
        temperature: 0.3,
    },

    document_integrations: {
        color: "#402080",
        description: "Task `document_integrations` to document external integrations",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            read: "allow",
        },
        prompt: documentIntegrationsPrompt,
        temperature: 0.3,
    },

    document_naming: {
        color: "#402080",
        description: "Task `document_naming` to document naming conventions in the project",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            read: "allow",
        },
        prompt: documentNamingPrompt,
        temperature: 0.3,
    },

    document_navigation: {
        color: "#402080",
        description: "Task `document_navigation` to document frontend navigation menu and page routing",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            read: "allow",
        },
        prompt: documentNavigationPrompt,
        temperature: 0.3,
    },

    document_readme: {
        color: "#402080",
        description: "Task `document_readme` to document README.md and AGENTS.md",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            read: "allow",
        },
        prompt: documentReadmePrompt,
        temperature: 0.3,
    },

    document_security: {
        color: "#402080",
        description: "Task `document_security` to document security architecture",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            read: "allow",
        },
        prompt: documentSecurityPrompt,
        temperature: 0.3,
    },

    document_standards: {
        color: "#402080",
        description: "Task `document_standards` to document uncommon standards in the project",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            read: "allow",
        },
        prompt: documentStandardsPrompt,
        temperature: 0.3,
    },

    document_style: {
        color: "#402080",
        description: "Task `document_style` to document frontend styling patterns and architecture",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            doom_loop: "allow",
            edit: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            read: "allow",
        },
        prompt: documentStylePrompt,
        temperature: 0.3,
    },

    execute: {
        color: "#FFFFFF",
        description: "Execute basic tasks without analysis or planning",
        hidden: false,
        mode: "primary",
        permission: {
            "*": "deny",
            plan_enter: "allow",
            question: "allow",
            read: "allow",
            submit_plan: "allow",
            task: {
                "*": "allow",
                build: "deny",
                orchestrate: "deny",
                plan: "deny",
                report: "deny"
            },
            "todo*": "allow"
        },
        prompt: executePrompt
    },

    modify_code: {
        color: "#802020",
        description: "Task `modify_code` to update the codebase with code, scripts, config, templates according to plain precise instructions; NEVER write md files with this agent",
        mode: "subagent",
        permission: {
            "*": "deny",
            "codesearch": "allow",
            "context7*": "allow",
            "doom_loop": "ask",
            "edit": "allow",
            external_directory: "ask",
            "glob": "allow",
            "grep": "allow",
            "list": "allow",
            "lsp": "allow",
            "read": "allow",
            "skill": {
                "*": "deny",
                "code*": "allow",
            },
            "todo*": "allow"
        },
        prompt: modifyCodePrompt,
        temperature: 0.1
    },

    modify_excel: {
        color: "#802020",
        description: "Task `modify_excel` to handle Excel workbook manipulations or data retrievals",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "ask",
            excel: "allow",
            external_directory: "ask",
            glob: "allow",
            list: "allow",
            "todo*": "allow",
        },
        prompt: modifyExcelPrompt,
        temperature: 0.1
    },

    modify_git: {
        color: "#802020",
        description: "Task `modify_git` to manage Git repositories with staging, commits, and branching",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "ask",
            edit: "allow",
            external_directory: "ask",
            "git*": "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            read: "allow",
        },
        prompt: modifyGitPrompt,
        temperature: 0.1,
    },

    modify_md: {
        color: "#802020",
        description: "Task `modify_md` to creates and updates documentation, articles, and technical content according to precise instructions; DO NOT used to edit source code or system config",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "ask",
            edit: "allow",
            external_directory: "ask",
            glob: "allow",
            grep: "allow",
            list: "allow",
            read: "allow",
            "todo*": "allow",
        },
        prompt: modifyMdPrompt,
        temperature: 0.1,
    },

    modify_os: {
        color: "#802020",
        description: "Task `modify_os` to execute scripts, bash commands, or administrate operating system; Not intended for read/write local codebase, not intended for browser automation, not intended for any online tasks",
        mode: "subagent",
        permission: {
            "*": "deny",
            bash: "allow",
            doom_loop: "ask",
            edit: "allow",
            "filesystem*": "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            "pty*": "allow",
            read: "allow",
            "todo*": "allow",
        },
        prompt: modifyOsPrompt,
        temperature: 0.1,
    },

    /**
     * Orchestrate: drives plan task execution in the correct sequential/concurrent order.
     * Spawned by the build agent after plan creation.
     * Only allowed to call autocode_orchestrate_* tools — no direct filesystem access.
     */
    orchestrate: {
        color: "#802040",
        description: "Orchestrate plan task execution — runs tasks in order, concurrently where possible",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_orchestrate*": "allow",
            doom_loop: "ask",
        },
        prompt: orchestratePrompt,
        temperature: 0.3,
    },

    orchestrate_coverage: {
        color: "#208020",
        description: "Task `orchestrate_coverage` to increase unit test coverage: discover untested code, write tests, fix failures (tests only, not code)",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "allow",
            question: "allow",
            task: {
                "*": "deny",
                modify_os: "allow",
                query_code: "allow",
                test: "allow",
            },
            "todo*": "allow",
        },
        prompt: orchestrateCoveragePrompt,
        temperature: 0.3,
    },

    orchestrate_documentation: {
        color: "#402080",
        description: "Task `orchestrate_documentation` to discover recent changes and update all affected documentation automatically",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "allow",
            question: "allow",
            task: {
                "*": "deny",
                "document*": "allow",
                query_code: "allow",
                query_git: "allow",
                query_text: "allow",
            },
            "todo*": "allow",
        },
        prompt: orchestrateDocumentationPrompt,
        temperature: 0.3,
    },

    orchestrate_excel: {
        color: "#802020",
        description: "Task `orchestrate_excel` to orchestrate excel workbook manipulations and data validation",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "allow",
            question: "allow",
            task: {
                "*": "deny",
                modify_excel: "allow",
                query_excel: "allow",
            },
            "todo*": "allow",
        },
        prompt: orchestrateExcelPrompt,
        temperature: 0.1,
    },

    orchestrate_feature: {
        color: "#802020",
        description: "Task `orchestrate_feature` to implement a feature end-to-end: write code, write tests, run tests, fix failures, confirm requirement is met",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "allow",
            question: "allow",
            task: {
                "*": "deny",
                modify_code: "allow",
                modify_os: "allow",
                query_code: "allow",
                query_git: "allow",
                test: "allow",
            },
            "todo*": "allow",
        },
        prompt: orchestrateFeaturePrompt,
        temperature: 0.3,
    },

    orchestrate_format: {
        color: "#802020",
        description: "Task `orchestrate_format` to orchestrate formatting of text files using safe git worktrees and custom scripts",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "allow",
            question: "allow",
            task: {
                "*": "deny",
                modify_code: "allow",
                modify_git: "allow",
                modify_os: "allow",
                query_code: "allow",
            },
            "todo*": "allow",
        },
        prompt: orchestrateFormatPrompt,
        temperature: 0.3,
    },

    orchestrate_general: {
        color: "#808080",
        description: "Task `orchestrate_general` only if no other subagents's description matches the requested task",
        mode: "subagent",
        permission: {
            "*": "deny",
            read: "allow",
            task: {
                "*": "allow",
                build: "deny",
                "orchestrate*": "deny",
                plan: "deny",
                report: "deny"
            },
            "todo*": "allow"
        },
    },

    orchestrate_git_commit: {
        color: "#802020",
        description: "Task `orchestrate_git_commit` only if reviewing changes and creating professional git commits",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "allow",
            question: "allow",
            task: {
                "*": "deny",
                modify_git: "allow",
                query_git: "allow",
            },
            "todo*": "allow",
        },
        prompt: orchestrateGitCommitPrompt,
        temperature: 0.1,
    },

    orchestrate_query: {
        color: "#202F8F",
        description: "Task `orchestrate_query` to query data, create research reports, find info user requested",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "allow",
            question: "allow",
            task: {
                "*": "deny",
                "query*": "allow",
            },
            "todo*": "allow",
        },
        prompt: orchestrateQueryPrompt,
        temperature: 0.5,
    },

    orchestrate_review_api: {
        color: "#808020",
        description: "Task `orchestrate_review_api` to review API changes: check endpoints, run tests, fix failures, and confirm API requirements are met",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "allow",
            question: "allow",
            task: {
                "*": "deny",
                modify_code: "allow",
                modify_os: "allow",
                query_code: "allow",
                query_git: "allow",
                test: "allow",
            },
            "todo*": "allow",
        },
        prompt: orchestrateReviewApiPrompt,
        temperature: 0.3,
    },

    orchestrate_review_ui: {
        color: "#808020",
        description: "Task `orchestrate_review_ui` to review UI changes: run application, inspect UI, run tests, fix failures, and confirm UI requirements are met",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "allow",
            question: "allow",
            task: {
                "*": "deny",
                modify_code: "allow",
                modify_os: "allow",
                query_browser: "allow",
                query_code: "allow",
                query_git: "allow",
                test: "allow",
            },
            "todo*": "allow",
        },
        prompt: orchestrateReviewUiPrompt,
        temperature: 0.3,
    },

    orchestrate_troubleshoot: {
        color: "#802020",
        description: "Task `orchestrate_troubleshoot` to diagnose and fix problems: reproduce if needed, find root cause, apply fix, verify, repeat until resolved",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "allow",
            question: "allow",
            task: {
                "*": "deny",
                modify_code: "allow",
                modify_os: "allow",
                "query*": "allow",
                troubleshoot: "allow",
            },
            "todo*": "allow",
        },
        prompt: orchestrateTroubleshootPrompt,
        temperature: 0.5,
    },

    plan: {
        color: "#404FFF",
        description: "Interactive Planning - Interview user, research problem, and create implementation plans",
        mode: "primary",
        permission: {
            "*": "deny",
            "autocode_analyze*": "allow",
            doom_loop: "ask",
            grep: "allow",
            plan_exit: "allow",
            question: "allow",
            read: "allow",
            submit_plan: "allow",
            task: {
                "*": "allow",
                analyze: "deny",
                build: "deny",
                "change*": "deny",
                "document*": "deny",
                human: "deny",
                md: "deny",
                report: "deny",
                test: "deny",
                troubleshoot: "deny",
            },
            webfetch: "allow",
        },
        prompt: planPrompt,
        temperature: 0.7
    },

    query_browser: {
        color: "#202F8F",
        description: "Use this agent for frontend development & testing - Debug, test and verify YOUR RUNNING APPLICATION: inspect DOM elements, read console logs, analyze network requests, click UI elements, test performance and automate frontend testing. NOT for online research nor internet searches.",
        hidden: true,
        mode: "subagent",
        permission: {
            '*': "deny",
            "chrome*": "allow",
            "doom_loop": "ask",
            "todo*": "allow"
        },
        prompt: queryBrowserPrompt
    },

    query_code: {
        color: "#202F8F",
        description: "Task `query_code` to find or read local code - locates, retrieves, and reads source code or understand implementation details from codebase",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            codesearch: "allow",
            "context7*": "allow",
            doom_loop: "ask",
            external_directory: "ask",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            read: "allow",
            skill: {
                "*": "deny",
                "code*": "allow",
            },
        },
        prompt: queryCodePrompt,
        temperature: 0.3,
    },

    query_excel: {
        color: "#202F8F",
        description: "Task `query_excel` to handle Excel workbook manipulations or data retrievals",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "ask",
            "excel_get*": "allow",
            "excel_read*": "allow",
            "excel_validate*": "allow",
            external_directory: "ask",
            glob: "allow",
            list: "allow",
        },
        prompt: queryExcelPrompt,
        temperature: 0.1
    },

    query_git: {
        color: "#202F8F",
        description: "Task `query_git` to manage Git repositories with staging, commits, and branching",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "ask",
            external_directory: "ask",
            "git_git_diff*": "allow",
            git_git_log: "allow",
            git_git_show: "allow",
            git_git_status: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            read: "allow",
        },
        prompt: queryGitPrompt,
        temperature: 0.1,
    },

    query_text: {
        color: "#202F8F",
        description: "Task `query_text` to find or read local config/files/md/settings/templates/assets/resources - locates, retrieves, and reads config values, markdown, text file content",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "ask",
            external_directory: "allow",
            glob: "allow",
            grep: "allow",
            list: "allow",
            lsp: "allow",
            read: "allow"
        },
        prompt: queryTextPrompt,
        temperature: 0.1,
    },

    query_web: {
        color: "#202F8F",
        description: "Task `query_web` to search and read public online web sources: documentation, articles, forums, GitHub, news",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "ask",
            "todo*": "allow",
            "websearch*": "allow",
            webfetch: "allow",
        },
        prompt: queryWebPrompt,
        temperature: 0.7,
    },

    test: {
        color: "#208020",
        description: "Task `test` to write unit tests or to improve code coverage",
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "ask",
            task: {
                "*": "deny",
                modify_code: "allow",
                modify_os: "allow",
                "query*": "allow",
                troubleshoot: "allow",
            },
            question: "allow",
            "todo*": "allow",
            webfetch: "allow",
        },
        prompt: testPrompt,
        temperature: 0.3,
    },

    troubleshoot: {
        color: "#808040",
        description: "Task `troubleshoot` to troubleshoot problems or to fix issues.",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            doom_loop: "ask",
            task: {
                "*": "allow",
                build: "deny",
                execute: "deny",
                orchestrate: "deny",
                plan: "deny",
                report: "deny"
            },
            "todo*": "allow",
        },
        prompt: troubleshootPrompt,
        temperature: 0.7,
    },

    /**
     * Interfering Opencode agents
     */
    explore: {
        disable: true
    },

    general: {
        disable: true
    }
}
