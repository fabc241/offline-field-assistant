/**
 * The CLI's view of a session (features/platform/session.ts): refusals and
 * log problems are told on stderr.
 */
import type { AppConfig } from '../core/config.js'
import type { SecretVault } from '../features/platform/keys.js'
import { READ_ONLY_FEATURES, type LicenseFeature } from '../features/platform/license.js'
import { openSession as openPlatformSession, type Session as PlatformSession } from '../features/platform/session.js'

export { modelsOf } from '../features/platform/session.js'

export interface Session extends PlatformSession {
  /**
   * True when the license covers `feature`. Otherwise says why on stderr,
   * records the refusal and returns false.
   */
  require(feature: LicenseFeature, action: string): Promise<boolean>
}

export async function openSession(config: AppConfig, opts: { vault?: SecretVault | null } = {}): Promise<Session> {
  const session = await openPlatformSession(config, {
    ...opts,
    onLogError: (err) => console.error(`⚠ Activity log: ${err.message}`)
  })
  if (!session.log) console.error('⚠ Activity log off: no key store on this platform')
  const { license } = session
  return {
    ...session,
    async require(feature, action) {
      const refusal = await session.refuse(feature, action)
      if (!refusal) {
        if (license.warnings.includes('expires-soon')) console.error(`⚠ ${license.message}: ask for a new license file`)
        if (license.warnings.includes('clock-behind')) console.error('⚠ This computer\'s clock is before the license\'s issue date: check the date')
        return true
      }
      console.error(`✖ ${refusal.message}`)
      if (license.mode !== 'full') {
        console.error(`  Still available: ${READ_ONLY_FEATURES.join(', ')}. Install a license with: ofa license install FILE`)
      }
      return false
    }
  }
}
