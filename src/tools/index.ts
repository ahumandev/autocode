import type { OpencodeClient } from "@opencode-ai/sdk"
import type { AutocodeSandboxConfig } from "../config"
import { createAutocodeAgentExecuteTool } from "./autocode_agent_execute"
import { createAutocodeAgentSwapTool } from "./autocode_agent_swap"
import { createAutocodeConceptCreateTool } from "./autocode_concept_create"
import { createAutocodeConceptListTool } from "./autocode_concept_list"
import { createAutocodeConceptReadTool } from "./autocode_concept_read"
import { createAutocodeConfigReadTool } from "./autocode_config_read"
import { createAutocodeConfigEditTool } from "./autocode_config_edit"
import { createAutocodeConfigRemoveTool } from "./autocode_config_remove"
import { createAutocodeMdReadTool } from "./autocode_md_read"
import { createAutocodeMdCreateTool } from "./autocode_md_create"
import { createAutocodeMdH1Tool } from "./autocode_md_h1"
import { createAutocodeMdUpdateTool } from "./autocode_md_update"
import { createAutocodeMdRemoveTool } from "./autocode_md_remove"
import { createAutocodeMdFrontmatterReadTool } from "./autocode_md_frontmatter_read"
import { createAutocodeMdFrontmatterEditTool } from "./autocode_md_frontmatter_edit"
import { createAutocodeSshConfigReadTool } from "./autocode_ssh_config_read"
import { createAutocodeSshConfigEditTool } from "./autocode_ssh_config_edit"
import { createAutocodeSshConfigRemoveTool } from "./autocode_ssh_config_remove"
import { createAutocodeDbSchemasTool, createAutocodeDbTableReadTool, createAutocodeDbTableTool, createAutocodeDbTablesTool } from "./autocode_db"
import { createAutocodeDependenciesTool } from "./autocode_dependencies"
import { createGitTools } from "./git"
import { createAutocodeJobExecuteTool } from "./autocode_job_execute"
import { createAutocodeJobListTool } from "./autocode_job_list"
import { createAutocodeJobShelveTool } from "./autocode_job_shelve"
import { createAutocodeJobStatusTool } from "./autocode_job_status"
import { createAutocodeKillTool } from "./autocode_kill"
import { createAutocodeLogoFindTool } from "./autocode_logo_find"
import { createAutocodePlanReadTool } from "./autocode_plan_read"
import { createAutocodePlanSaveTool } from "./autocode_plan_save"
import { createAutocodeRestTool } from "./autocode_rest"
import { createAutocodeSandboxCliTool } from "./autocode_sandbox_cli"
import { createAutocodeSandboxCreateTool } from "./autocode_sandbox_create"
import { createAutocodeSandboxDeleteTool } from "./autocode_sandbox_delete"
import { createAutocodeSandboxCopyTool, createAutocodeSandboxEditTool, createAutocodeSandboxGlobTool, createAutocodeSandboxGrepTool, createAutocodeSandboxReadTool } from "./autocode_sandbox_file_tools"
import { createAutocodeSandboxConfigEditTool, createAutocodeSandboxConfigReadTool, createAutocodeSandboxConfigRemoveTool } from "./autocode_sandbox_config_tools"
import { createAutocodeSessionContextTool } from "./autocode_session_context"
import { createAutocodeSkillEditTool } from "./skill_edit"
import { createAutocodeSkillReadTool } from "./skill_read"
import { createSkillEditReferenceTool } from "./skill_edit_reference"
import { createSkillReadReferenceTool } from "./skill_read_reference"
import { createAutocodeSshCommandTool, createAutocodeSshEditFileTool, createAutocodeSshGlobTool, createAutocodeSshGrepFileTool, createAutocodeSshListTool, createAutocodeSshPatchFileTool, createAutocodeSshReadAttributesTool, createAutocodeSshReadFileTool, createAutocodeSshWriteAttributesTool, createAutocodeSshWriteFileTool } from "./autocode_ssh"
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
        ...createGitTools(),

        autocode_agent_execute: createAutocodeAgentExecuteTool(client),
        autocode_agent_swap: createAutocodeAgentSwapTool(client),
        autocode_concept_create: createAutocodeConceptCreateTool(client),
        autocode_concept_list: createAutocodeConceptListTool(),
        autocode_concept_read: createAutocodeConceptReadTool(client),
        autocode_config_edit: createAutocodeConfigEditTool(),
        autocode_config_read: createAutocodeConfigReadTool(),
        autocode_config_remove: createAutocodeConfigRemoveTool(),
        autocode_db_schemas: createAutocodeDbSchemasTool(),
        autocode_db_table: createAutocodeDbTableTool(),
        autocode_db_table_read: createAutocodeDbTableReadTool(),
        autocode_db_tables: createAutocodeDbTablesTool(),
        autocode_dependencies: createAutocodeDependenciesTool(),
        autocode_job_execute: createAutocodeJobExecuteTool(client),
        autocode_job_list: createAutocodeJobListTool(),
        autocode_job_shelve: createAutocodeJobShelveTool(client),
        autocode_job_status: createAutocodeJobStatusTool(client),
        autocode_kill: createAutocodeKillTool(),
        autocode_logo_find: createAutocodeLogoFindTool(),
        autocode_md_create: createAutocodeMdCreateTool(),
        autocode_md_frontmatter_edit: createAutocodeMdFrontmatterEditTool(),
        autocode_md_frontmatter_read: createAutocodeMdFrontmatterReadTool(),
        autocode_md_h1: createAutocodeMdH1Tool(),
        autocode_md_read: createAutocodeMdReadTool(),
        autocode_md_remove: createAutocodeMdRemoveTool(),
        autocode_md_update: createAutocodeMdUpdateTool(),
        autocode_plan_read: createAutocodePlanReadTool(client),
        autocode_plan_save: createAutocodePlanSaveTool(client),
        autocode_rest: createAutocodeRestTool(client),
        autocode_sandbox_cli: createAutocodeSandboxCliTool(client),
        autocode_sandbox_config_edit: createAutocodeSandboxConfigEditTool(client),
        autocode_sandbox_config_read: createAutocodeSandboxConfigReadTool(client),
        autocode_sandbox_config_remove: createAutocodeSandboxConfigRemoveTool(client),
        autocode_sandbox_copy: createAutocodeSandboxCopyTool(client),
        autocode_sandbox_create: createAutocodeSandboxCreateTool(client, undefined, sandboxConfig),
        autocode_sandbox_delete: createAutocodeSandboxDeleteTool(client),
        autocode_sandbox_edit: createAutocodeSandboxEditTool(client),
        autocode_sandbox_glob: createAutocodeSandboxGlobTool(client),
        autocode_sandbox_grep: createAutocodeSandboxGrepTool(client),
        autocode_sandbox_read: createAutocodeSandboxReadTool(client),
        autocode_session_context: createAutocodeSessionContextTool(client),
        autocode_session_create: createAutocodeSessionCreateTool(client),
        autocode_ssh_command: createAutocodeSshCommandTool(),
        autocode_ssh_config_edit: createAutocodeSshConfigEditTool(),
        autocode_ssh_config_read: createAutocodeSshConfigReadTool(),
        autocode_ssh_config_remove: createAutocodeSshConfigRemoveTool(),
        autocode_ssh_edit_file: createAutocodeSshEditFileTool(),
        autocode_ssh_glob: createAutocodeSshGlobTool(),
        autocode_ssh_grep_file: createAutocodeSshGrepFileTool(),
        autocode_ssh_list: createAutocodeSshListTool(),
        autocode_ssh_patch_file: createAutocodeSshPatchFileTool(),
        autocode_ssh_read_attributes: createAutocodeSshReadAttributesTool(),
        autocode_ssh_read_file: createAutocodeSshReadFileTool(),
        autocode_ssh_write_attributes: createAutocodeSshWriteAttributesTool(),
        autocode_ssh_write_file: createAutocodeSshWriteFileTool(),
        skill: createSkillTool(client, undefined, runtime),
        skill_edit: createAutocodeSkillEditTool(),
        skill_learn_correction: createSkillLearnCorrectionTool(),
        skill_learn_env: createSkillLearnEnvTool(),
        skill_learn_permission: createSkillLearnPermissionTool(),
        skill_learn_preference: createSkillLearnPreferenceTool(),
        skill_read: createAutocodeSkillReadTool(),
        skill_edit_reference: createSkillEditReferenceTool(),
        skill_read_reference: createSkillReadReferenceTool(),
        task_external: createTaskExternalTool(),
        task_resume: createTaskResumeTool(client),    
    }
}
