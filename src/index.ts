// src/index.ts — Barrel exports for the autocode library

// Core types
export type {
  AutocodeConfig,
  Plan,
  Task,
  TaskTree,
  TaskStatus,
  Stage,
  SessionMeta,
  TaskSessionInfo,
  TaskSummary,
  TaskExecutionResult,
} from "./core/types"

// Configuration
export { loadConfig, createConfig } from "./core/config"

// Setup
export { initAutocode } from "./setup"
