/**
 * What a release build must have before it is made: a Developer ID identity
 * to sign with, a notarytool profile, and the vendor's own keys compiled in.
 * The development keys sign the placeholder pack and the dev license; a
 * device that trusted them would accept anything signed on the dev machine.
 */
import type { TrustedKey } from '../features/packs/signing.js'

export const DEVELOPER_ID = /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/
const DEV_KEY = /not for release/i

export interface ReleaseInputs {
  /** OFA_SIGN_IDENTITY. */
  identity?: string
  /** OFA_NOTARY_PROFILE: a `xcrun notarytool store-credentials` profile. */
  notaryProfile?: string
  packKeys: readonly TrustedKey[]
  licenseKeys: readonly TrustedKey[]
}

/** Everything that stops a release; empty when it may go ahead. */
export function releaseProblems(r: ReleaseInputs): string[] {
  const problems: string[] = []
  if (!r.identity) problems.push('OFA_SIGN_IDENTITY is not set: a release is signed with a "Developer ID Application" certificate')
  else if (!DEVELOPER_ID.test(r.identity)) problems.push(`OFA_SIGN_IDENTITY "${r.identity}" is not a Developer ID Application identity`)
  if (!r.notaryProfile) problems.push('OFA_NOTARY_PROFILE is not set: create one with xcrun notarytool store-credentials')
  for (const [what, keys, file] of [
    ['pack', r.packKeys, 'src/features/packs/trusted-keys.ts'],
    ['license', r.licenseKeys, 'src/features/platform/license-keys.ts']
  ] as const) {
    if (!keys.length) problems.push(`No ${what} keys are trusted (${file})`)
    for (const k of keys.filter((k) => DEV_KEY.test(k.label))) {
      problems.push(`The ${what} key "${k.label}" (${k.keyId}) is a development key: replace it with the vendor's release key in ${file}`)
    }
  }
  return problems
}

/** True when the build trusts a development key: the tray and the package report say so. */
export const isDevelopmentBuild = (keys: readonly TrustedKey[]) => keys.some((k) => DEV_KEY.test(k.label))
