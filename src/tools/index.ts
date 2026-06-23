import type { OpencodeClient } from "@opencode-ai/sdk"
import type { AutocodeSandboxConfig } from "../config"
import { createAutocodeAgentExecuteTool } from "./autocode_agent_execute"
import { createAutocodeAgentPreviousTool } from "./autocode_agent_previous"
import { createAutocodeAgentSwapTool } from "./autocode_agent_swap"
import { createAutocodeConceptCreateTool } from "./autocode_concept_create"
import { createAutocodeConceptListTool } from "./autocode_concept_list"
import { createAutocodeConceptReadTool } from "./autocode_concept_read"
import { createAutocodeDbSchemasTool, createAutocodeDbTableReadTool, createAutocodeDbTableTool, createAutocodeDbTablesTool } from "./autocode_db"
import { createAutocodeDependenciesTool } from "./autocode_dependencies"
import { createGitTools } from "./autocode_git"
import { createAutocodeJobExecuteTool } from "./autocode_job_execute"
import { createAutocodeJobListTool } from "./autocode_job_list"
import { createAutocodeJobShelveTool } from "./autocode_job_shelve"
import { createAutocodeJobStatusTool } from "./autocode_job_status"
import { createAutocodeLogoFindTool } from "./autocode_logo_find"
import { createAutocodePlanReadTool } from "./autocode_plan_read"
import { createAutocodePlanSaveTool } from "./autocode_plan_save"
import { createAutocodeRestResponseEvalTool, createAutocodeRestResponseGrepTool, createAutocodeRestResponseReadTool, createAutocodeRestTool } from "./autocode_rest"
import { createAutocodeSandboxCliTool } from "./autocode_sandbox_cli"
import { createAutocodeSandboxCreateTool } from "./autocode_sandbox_create"
import { createAutocodeSandboxDeleteTool } from "./autocode_sandbox_delete"
import { createAutocodeSandboxCopyTool, createAutocodeSandboxEditTool, createAutocodeSandboxGlobTool, createAutocodeSandboxGrepTool, createAutocodeSandboxReadTool } from "./autocode_sandbox_file_tools"
import { createAutocodeSessionContextTool } from "./autocode_session_context"
import { createAutocodeSessionCreateTool } from "./autocode_session_create"
import { createSkillLearnCorrectionTool, createSkillLearnEnvTool, createSkillLearnPermissionTool, createSkillLearnPreferenceTool } from "./skill_learn"
import { createSkillTool } from "./skill"
import { createTaskProjectTool as createTaskExternalTool } from "./task_external"
import { createTaskResumeTool } from "./task_resume"

type ToolRuntime = {
    serverUrl?: string | URL
}

export function createTools(client: OpencodeClient, sandboxConfig: AutocodeSandboxConfig = {}, runtime?: ToolRuntime) {
    return {
        autocode_agent_execute: createAutocodeAgentExecuteTool(client),
        autocode_agent_previous: createAutocodeAgentPreviousTool(client),
        autocode_agent_swap: createAutocodeAgentSwapTool(client),
        autocode_concept_create: createAutocodeConceptCreateTool(client),
        autocode_concept_list: createAutocodeConceptListTool(),
        autocode_concept_read: createAutocodeConceptReadTool(client),
        autocode_db_schemas: createAutocodeDbSchemasTool(),
        autocode_db_table_read: createAutocodeDbTableReadTool(),
        autocode_db_table: createAutocodeDbTableTool(),
        autocode_db_tables: createAutocodeDbTablesTool(),
        autocode_dependencies: createAutocodeDependenciesTool(),
        autocode_job_list: createAutocodeJobListTool(),
        autocode_job_execute: createAutocodeJobExecuteTool(client),
        autocode_job_shelve: createAutocodeJobShelveTool(client),
        autocode_job_status: createAutocodeJobStatusTool(client),
        autocode_logo_find: createAutocodeLogoFindTool(),
        autocode_plan_read: createAutocodePlanReadTool(client),
        autocode_plan_save: createAutocodePlanSaveTool(client),
        autocode_rest: createAutocodeRestTool(client),
        autocode_rest_response_eval: createAutocodeRestResponseEvalTool(client),
        autocode_rest_response_read: createAutocodeRestResponseReadTool(client),
        autocode_rest_grep: createAutocodeRestResponseGrepTool(client),
        autocode_sandbox_cli: createAutocodeSandboxCliTool(client),
        autocode_sandbox_copy: createAutocodeSandboxCopyTool(client),
        autocode_sandbox_create: createAutocodeSandboxCreateTool(client, undefined, sandboxConfig),
        autocode_sandbox_delete: createAutocodeSandboxDeleteTool(client),
        autocode_sandbox_edit: createAutocodeSandboxEditTool(client),
        autocode_sandbox_glob: createAutocodeSandboxGlobTool(client),
        autocode_sandbox_grep: createAutocodeSandboxGrepTool(client),
        autocode_sandbox_read: createAutocodeSandboxReadTool(client),
        autocode_session_context: createAutocodeSessionContextTool(client),
        autocode_session_create: createAutocodeSessionCreateTool(client),
        skill_learn_correction: createSkillLearnCorrectionTool(),
        skill_learn_env: createSkillLearnEnvTool(),
        skill_learn_permission: createSkillLearnPermissionTool(),
        skill_learn_preference: createSkillLearnPreferenceTool(),
        skill: createSkillTool(client, undefined, runtime),
        ...createGitTools(),
        task_external: createTaskExternalTool(),
        task_resume: createTaskResumeTool(client),
    }
}
