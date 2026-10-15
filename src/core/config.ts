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
  /** Installed content packs (OFA_PACKS_DIR). */
  packsDir: string
  /** Encrypted activity log, one file per day (OFA_LOG_DIR). */
  logDir: string
  /** Also log what people said and read, not just metadata (OFA_LOG_TRANSCRIPTS=1). Off by default. */
  logTranscripts: boolean
  /** Keychain service holding the log key (OFA_KEYCHAIN_SERVICE). */
  keychainService: string
  /** The installed license file (OFA_LICENSE). */
  licenseFile: string
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
    },
    packsDir: path.resolve(env.OFA_PACKS_DIR ?? path.join(PROJECT_ROOT, 'var/packs')),
    logDir: path.resolve(env.OFA_LOG_DIR ?? path.join(PROJECT_ROOT, 'var/logs')),
    logTranscripts: flag(env, 'OFA_LOG_TRANSCRIPTS'),
    keychainService: env.OFA_KEYCHAIN_SERVICE || 'Offline Field Assistant',
    licenseFile: path.resolve(env.OFA_LICENSE ?? path.join(PROJECT_ROOT, 'var/license/license.ofalicense'))
  }
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = (env[name] ?? '').toLowerCase()
  if (value === '1' || value === 'true') return true
  if (value === '' || value === '0' || value === 'false') return false
  throw new Error(`${name} must be 1 or 0, got "${env[name]}"`)
}
