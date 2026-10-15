/**
 * The offline license: a small JSON file signed with Ed25519 by the vendor's
 * key, checked at start-up against the vendor keys built into the app and
 * never online.
 *
 * Only a valid license opens the app in full. Anything else (expired, missing,
 * forged, or for another device) opens it read-only: the phrasebook and the
 * guide stay available, so a clinic is never locked out of the danger signs
 * and the recorded phrases. Start-up decides the mode for the whole session,
 * so a license that runs out mid-shift changes nothing until the app is
 * started again.
 *
 * Seats are recorded for the program's count but cannot be enforced offline;
 * a license with a deviceId opens only on that device.
 */
import fs from 'node:fs/promises'
import { z } from 'zod'
import { SLUG, canonicalJson } from '../packs/manifest.js'
import { PackSignatureSchema, checkSignature, signManifest, type TrustedKey } from '../packs/signing.js'
import type { KeyObject } from 'node:crypto'
import { DEVICE_ID } from './device.js'

export const LICENSE_FEATURES = ['conversation', 'translate', 'speech', 'read-aloud', 'documents', 'guide', 'phrasebook', 'packs'] as const
export type LicenseFeature = (typeof LICENSE_FEATURES)[number]

/** Available in every mode, licensed or not: looking up content already on the device. */
export const READ_ONLY_FEATURES: readonly LicenseFeature[] = ['guide', 'phrasebook']

/** A license this close to its expiry gets a warning. */
export const EXPIRY_WARNING_DAYS = 30

const DAY_MS = 86_400_000

export const LicenseSchema = z
  .strictObject({
    format: z.literal(1),
    kind: z.literal('license'),
    /** e.g. "acme-health-2026-001". */
    id: z.string().regex(SLUG, 'lowercase letters, digits and dashes'),
    licensee: z.string().min(1).max(200),
    seats: z.number().int().positive().max(1_000_000),
    issued: z.iso.datetime(),
    expiry: z.iso.datetime(),
    features: z
      .array(z.enum(LICENSE_FEATURES))
      .min(1)
      .refine((f) => new Set(f).size === f.length, 'features repeat'),
    deviceId: z.string().regex(DEVICE_ID).optional()
  })
  .refine((l) => Date.parse(l.expiry) > Date.parse(l.issued), { message: 'expiry must be after issued', path: ['expiry'] })
export type License = z.infer<typeof LicenseSchema>

export const LicenseFileSchema = z.strictObject({
  format: z.literal(1),
  license: LicenseSchema,
  signature: PackSignatureSchema
})

/** Signed bytes start with this, so no other signature by the same key (a pack manifest) can pass for a license. */
const DOMAIN = 'ofa-license-v1\n'
const signedBytes = (license: License) => Buffer.from(DOMAIN + canonicalJson(license), 'utf8')

/** Signs a license; returns the license file's text. */
export function issueLicense(license: License, privateKey: KeyObject): string {
  const parsed = LicenseSchema.parse(license)
  return canonicalJson({ format: 1, license: parsed, signature: signManifest(signedBytes(parsed), privateKey) })
}

export type LicenseStatus = 'valid' | 'expired' | 'missing' | 'invalid' | 'wrong-device'
export type LicenseProblem = 'malformed' | 'unknown-key' | 'bad-signature'

export interface LicenseState {
  status: LicenseStatus
  mode: 'full' | 'read-only'
  /** Present when the signature is good, even if the license has expired or is for another device. */
  license?: License
  signedBy?: { keyId: string; label: string }
  /** Why an `invalid` license was refused. */
  problem?: LicenseProblem
  /** Whole days until expiry; negative once expired. */
  daysLeft?: number
  /** `expires-soon`; `clock-behind` when the clock is before the issue date (the license is still honored). */
  warnings: ('expires-soon' | 'clock-behind')[]
  /** One line for people. */
  message: string
  /** This device's id, when it could be read. */
  deviceId?: string
  checkedAt: string
}

export interface LicenseCheckOptions {
  trustedKeys: readonly TrustedKey[]
  deviceId?: string
  now?: Date
}

const READ_ONLY_NOTE = 'read-only mode (phrasebook and guide only)'

/** Checks a license file's text (undefined: no file). */
export function checkLicense(text: string | undefined, opts: LicenseCheckOptions): LicenseState {
  const now = opts.now ?? new Date()
  const base = { warnings: [], checkedAt: now.toISOString(), ...(opts.deviceId ? { deviceId: opts.deviceId } : {}) }
  const readOnly = (status: LicenseStatus, message: string, extra: Partial<LicenseState> = {}): LicenseState => ({
    ...base,
    status,
    mode: 'read-only',
    message: `${message}: ${READ_ONLY_NOTE}`,
    ...extra
  })

  if (text === undefined) return readOnly('missing', 'No license installed')
  const file = parseFile(text)
  if (!file) return readOnly('invalid', 'The license file is damaged or not a license', { problem: 'malformed' })
  const sig = checkSignature(signedBytes(file.license), file.signature, opts.trustedKeys)
  if (!sig.ok) {
    const why = sig.problem === 'unknown-key' ? 'is not signed by a vendor key this app trusts' : 'has been altered since it was signed'
    return readOnly('invalid', `The license file ${why}`, { problem: sig.problem })
  }

  const { license } = file
  const signed = { license, signedBy: { keyId: sig.key.keyId, label: sig.key.label } }
  const expiry = Date.parse(license.expiry)
  const daysLeft = Math.floor((expiry - now.getTime()) / DAY_MS)
  if (license.deviceId && license.deviceId !== opts.deviceId) {
    return readOnly('wrong-device', `This license is for device ${license.deviceId}, not this one (${opts.deviceId ?? 'id unavailable'})`, signed)
  }
  if (now.getTime() >= expiry) {
    return readOnly('expired', `The license for ${license.licensee} expired on ${license.expiry.slice(0, 10)}`, { ...signed, daysLeft })
  }
  const warnings: LicenseState['warnings'] = []
  if (daysLeft < EXPIRY_WARNING_DAYS) warnings.push('expires-soon')
  if (now.getTime() < Date.parse(license.issued)) warnings.push('clock-behind')
  return {
    ...base,
    ...signed,
    status: 'valid',
    mode: 'full',
    daysLeft,
    warnings,
    message: `Licensed to ${license.licensee} until ${license.expiry.slice(0, 10)} (${daysLeft} days)`
  }
}

/** Reads and checks the license file at `file`; a missing file is `missing`. */
export async function readLicense(file: string, opts: LicenseCheckOptions): Promise<LicenseState> {
  const text = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined
    throw err
  })
  return checkLicense(text, opts)
}

/** Whether this session may use `feature`. */
export function allows(state: LicenseState, feature: LicenseFeature): boolean {
  if (READ_ONLY_FEATURES.includes(feature)) return true
  return state.mode === 'full' && state.license !== undefined && state.license.features.includes(feature)
}

function parseFile(text: string): z.infer<typeof LicenseFileSchema> | undefined {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  const parsed = LicenseFileSchema.safeParse(json)
  // Canonical bytes only: what was signed is exactly what is on disk.
  if (!parsed.success || canonicalJson(parsed.data) !== text) return undefined
  return parsed.data
}
