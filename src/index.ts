// src/index.ts — Barrel exports for the autocode library

// Core types
export type {
  AutocodeConfig,
  Plan,
  Task,
  TaskTree,
  TaskStatus,
  Stage,
  IdeaFile,
  SessionMeta,
  TaskSessionInfo,
  TaskSummary,
  TaskExecutionResult,
} from "./core/types"

// Re-export Zod schemas
export { Stage as StageSchema, TaskStatus as TaskStatusSchema } from "./core/types"

// Scanner
export {
  scanIdeas,
  scanPlans,
  scanTaskTree,
  findNextExecutableTasks,
  parseTaskOrder,
  summarizeTaskTree,
  validatePlanName,
  isPlanNameUnique,
} from "./core/scanner"

// State manager
export {
  moveTaskStatus,
  movePlanToStage,
  archivePlan,
  updateSessionMeta,
  readSessionMeta,
  createProblemLinks,
  unhideReviewMd,
  resetBusyTasks,
  deleteIdea,
  createPlanStructure,
} from "./core/state"

// Configuration
export { loadConfig, createConfig } from "./core/config"

// SDK orchestration
export { executeTask, executeParallelTasks, abortSession } from "./sdk/orchestrator"
export { exportSessionToMarkdown, extractSessionSummary } from "./sdk/session-exporter"

// Spec generation
export { generateSpec, collectTaskSessions } from "./specs/generator"
export { registerSpecAsSkill } from "./specs/skill-writer"

// Setup
export { initAutocode } from "./setup"
