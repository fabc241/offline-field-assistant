/**
 * What every ofa command starts with: the license, checked once at start-up,
 * and the encrypted activity log. The log key is read from the Keychain only
 * when something is first recorded.
 */
import { createRequire } from 'node:module'
import type { AppConfig } from '../core/config.js'
import { sdkVersion } from '../core/qvac.js'
import { ActivityLog, type ActivityInput } from '../features/platform/activity.js'
import { deviceId } from '../features/platform/device.js'
import { KeyProvider, keychainVault } from '../features/platform/keys.js'
import { TRUSTED_LICENSE_KEYS } from '../features/platform/license-keys.js'
import { READ_ONLY_FEATURES, allows, readLicense, type LicenseFeature, type LicenseState } from '../features/platform/license.js'
import { SecureLog } from '../features/platform/secure-log.js'

export interface Session {
  readonly license: LicenseState
  readonly activity: ActivityLog
  /** Undefined where there is no key store (not macOS). */
  readonly log: SecureLog | undefined
  readonly keys: KeyProvider | undefined
  /**
   * True when the license covers `feature`. Otherwise says why on stderr,
   * records the refusal and returns false.
   */
  require(feature: LicenseFeature, action: string): Promise<boolean>
  close(): Promise<void>
}

const APP_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version

export async function openSession(config: AppConfig): Promise<Session> {
  const license = await readLicense(config.licenseFile, { trustedKeys: TRUSTED_LICENSE_KEYS, deviceId: await deviceId() })
  const keys = process.platform === 'darwin' ? new KeyProvider(keychainVault({ service: config.keychainService })) : undefined
  const log = keys ? new SecureLog(config.logDir, keys) : undefined
  let warned = false
  const activity = new ActivityLog(log, {
    app: APP_VERSION,
    sdk: await sdkVersion(),
    transcripts: config.logTranscripts,
    onError: (err) => {
      if (warned) return
      warned = true
      console.error(`⚠ Activity log: ${err.message}`)
    }
  })
  if (!log) console.error('⚠ Activity log off: no key store on this platform')

  return {
    license,
    activity,
    log,
    keys,
    async require(feature, action) {
      if (allows(license, feature)) {
        if (license.warnings.includes('expires-soon')) console.error(`⚠ ${license.message}: ask for a new license file`)
        if (license.warnings.includes('clock-behind')) console.error('⚠ This computer\'s clock is before the license\'s issue date: check the date')
        return true
      }
      if (license.mode === 'full') {
        console.error(`✖ This license does not include ${feature} (it covers: ${license.license!.features.join(', ')})`)
      } else {
        console.error(`✖ ${feature} is not available. ${license.message}.`)
        console.error(`  Still available: ${READ_ONLY_FEATURES.join(', ')}. Install a license with: ofa license install FILE`)
      }
      await activity.record({ feature, action, outcome: 'refused', reason: license.mode === 'full' ? 'not-licensed' : `license-${license.status}` })
      return false
    },
    close: () => activity.flush()
  }
}

/** Shorthand for the metadata every model-backed record carries. */
export const modelsOf = (runtime: { modelVersions(): string[] }): Pick<ActivityInput, 'models'> => {
  const models = runtime.modelVersions()
  return models.length ? { models } : {}
}
