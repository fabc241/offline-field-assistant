import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const GB = 1024 ** 3

export interface AppConfig {
  /** Directory holding model files and manifest.json. */
  modelsDir: string
  /** Upper bound for the summed size of loaded models, in bytes. */
  memoryBudgetBytes: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const budgetGb = env.OFA_MEMORY_BUDGET_GB ? Number(env.OFA_MEMORY_BUDGET_GB) : 10
  if (!Number.isFinite(budgetGb) || budgetGb <= 0) {
    throw new Error(`OFA_MEMORY_BUDGET_GB must be a positive number, got "${env.OFA_MEMORY_BUDGET_GB}"`)
  }
  return {
    modelsDir: path.resolve(env.OFA_MODELS_DIR ?? path.join(PROJECT_ROOT, 'models')),
    memoryBudgetBytes: budgetGb * GB
  }
}
