/**
 * What every entry point (the CLI, the Electron app) starts with: the
 * license, checked once at start-up, and the encrypted activity log. The log
 * key is read from its vault only when something is first recorded.
 */
import type { AppConfig } from '../../core/config.js'
import { sdkVersion } from '../../core/qvac.js'
import { ActivityLog, type ActivityInput } from './activity.js'
import { deviceId } from './device.js'
import { KeyProvider, keychainVault, type SecretVault } from './keys.js'
import { TRUSTED_LICENSE_KEYS } from './license-keys.js'
import { READ_ONLY_FEATURES, allows, readLicense, type LicenseFeature, type LicenseState } from './license.js'
import { SecureLog } from './secure-log.js'
import type { TrustedKey } from '../packs/signing.js'
import pkg from '../../../package.json' with { type: 'json' }

export const APP_VERSION: string = pkg.version

/** Why a licensed feature was refused, for people and for the log. */
export interface Refusal {
  feature: LicenseFeature
  /** One line for people. */
  message: string
  /** What else this session can do. */
  available: LicenseFeature[]
  /** Token for the activity log, e.g. "license-expired". */
  reason: string
}

export interface Session {
  readonly license: LicenseState
  readonly activity: ActivityLog
  /** Undefined where there is no key store. */
  readonly log: SecureLog | undefined
  readonly keys: KeyProvider | undefined
  /** Undefined when the license covers `feature`; otherwise records the refusal and says why. */
  refuse(feature: LicenseFeature, action: string): Promise<Refusal | undefined>
  close(): Promise<void>
}

export interface SessionOptions {
  /** Where the log key lives. Default: the macOS Keychain (none elsewhere). */
  vault?: SecretVault | null
  trustedLicenseKeys?: readonly TrustedKey[]
  /** Told once when the log cannot be written. */
  onLogError?: (err: Error) => void
}

export async function openSession(config: AppConfig, opts: SessionOptions = {}): Promise<Session> {
  const license = await readLicense(config.licenseFile, {
    trustedKeys: opts.trustedLicenseKeys ?? TRUSTED_LICENSE_KEYS,
    deviceId: await deviceId()
  })
  const vault =
    opts.vault !== undefined ? opts.vault : process.platform === 'darwin' ? keychainVault({ service: config.keychainService }) : null
  const keys = vault ? new KeyProvider(vault) : undefined
  const log = keys ? new SecureLog(config.logDir, keys) : undefined
  let warned = false
  const activity = new ActivityLog(log, {
    app: APP_VERSION,
    sdk: await sdkVersion(),
    transcripts: config.logTranscripts,
    onError: (err) => {
      if (warned) return
      warned = true
      opts.onLogError?.(err)
    }
  })

  return {
    license,
    activity,
    log,
    keys,
    async refuse(feature, action) {
      if (allows(license, feature)) return undefined
      const full = license.mode === 'full'
      const refusal: Refusal = {
        feature,
        message: full
          ? `This license does not include ${feature} (it covers: ${license.license!.features.join(', ')})`
          : `${feature} is not available. ${license.message}.`,
        available: full ? [...license.license!.features] : [...READ_ONLY_FEATURES],
        reason: full ? 'not-licensed' : `license-${license.status}`
      }
      await activity.record({ feature, action, outcome: 'refused', reason: refusal.reason })
      return refusal
    },
    close: () => activity.flush()
  }
}

/** Shorthand for the metadata every model-backed record carries. */
export const modelsOf = (runtime: { modelVersions(): string[] }): Pick<ActivityInput, 'models'> => {
  const models = runtime.modelVersions()
  return models.length ? { models } : {}
}
