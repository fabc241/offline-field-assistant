import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Lang } from './engines.js'

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const GB = 1024 ** 3

export interface AppConfig {
  /** Directory holding model files and manifest.json. */
  modelsDir: string
  /** Upper bound for the summed size of loaded models, in bytes. */
  memoryBudgetBytes: number
  /**
   * Consented native-speaker recordings to read aloud with, per language
   * (OFA_VOICE_EN, OFA_VOICE_SW). Unset: Chatterbox's built-in voice.
   */
  voices: Partial<Record<Lang, string>>
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const budgetGb = env.OFA_MEMORY_BUDGET_GB ? Number(env.OFA_MEMORY_BUDGET_GB) : 10
  if (!Number.isFinite(budgetGb) || budgetGb <= 0) {
    throw new Error(`OFA_MEMORY_BUDGET_GB must be a positive number, got "${env.OFA_MEMORY_BUDGET_GB}"`)
  }
  return {
    modelsDir: path.resolve(env.OFA_MODELS_DIR ?? path.join(PROJECT_ROOT, 'models')),
    memoryBudgetBytes: budgetGb * GB,
    voices: {
      ...(env.OFA_VOICE_EN ? { en: path.resolve(env.OFA_VOICE_EN) } : {}),
      ...(env.OFA_VOICE_SW ? { sw: path.resolve(env.OFA_VOICE_SW) } : {})
    }
  }
}
