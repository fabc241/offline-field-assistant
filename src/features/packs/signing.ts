/**
 * Ed25519 signatures over a pack's manifest bytes. The manifest lists the
 * sha256 of every other file, so one signature covers the whole pack.
 *
 * A key is named by its id: the first 16 hex digits of the sha256 of its
 * public key (SPKI DER). The id is derived, never declared, so a signature
 * cannot claim a trusted key it was not made with.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { z } from 'zod'

export const SIGNATURE_FILE = 'manifest.sig'

export interface TrustedKey {
  keyId: string
  /** Who holds the private key, for messages, e.g. "OFA development key". */
  label: string
  publicKey: KeyObject
}

export const PackSignatureSchema = z.strictObject({
  format: z.literal(1),
  algorithm: z.literal('ed25519'),
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  /** Base64 of the 64-byte signature. */
  signature: z
    .string()
    .regex(/^[A-Za-z0-9+/]{86}==$/)
    // Unused low bits in the last character would decode to the same bytes.
    .refine((s) => Buffer.from(s, 'base64').toString('base64') === s, 'not canonical base64')
})
export type PackSignature = z.infer<typeof PackSignatureSchema>

export function keyIdOf(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
}

export function trustedKey(label: string, publicKeyPem: string): TrustedKey {
  const publicKey = createPublicKey(publicKeyPem)
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error(`Trusted key "${label}" is not an Ed25519 public key`)
  return { keyId: keyIdOf(publicKey), label, publicKey }
}

export interface GeneratedKey {
  keyId: string
  /** PKCS#8, encrypted with AES-256 when a passphrase was given. */
  privateKeyPem: string
  publicKeyPem: string
}

export function generateSigningKey(passphrase?: string): GeneratedKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: passphrase
      ? { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }
      : { type: 'pkcs8', format: 'pem' }
  })
  return { keyId: keyIdOf(createPublicKey(publicKey)), privateKeyPem: privateKey, publicKeyPem: publicKey }
}

/** Reads a private key PEM; an encrypted one needs its passphrase. */
export function loadPrivateKey(pem: string, passphrase?: string): KeyObject {
  let key: KeyObject
  try {
    key = createPrivateKey(passphrase ? { key: pem, passphrase } : pem)
  } catch (err) {
    const encrypted = pem.includes('ENCRYPTED')
    throw new Error(
      encrypted && !passphrase
        ? 'The signing key is encrypted: set OFA_PACK_KEY_PASSPHRASE'
        : `Cannot read the signing key: ${(err as Error).message}`
    )
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key is not an Ed25519 private key')
  return key
}

export function signManifest(manifestBytes: Uint8Array, privateKey: KeyObject): PackSignature {
  return {
    format: 1,
    algorithm: 'ed25519',
    keyId: keyIdOf(createPublicKey(privateKey)),
    signature: sign(null, manifestBytes, privateKey).toString('base64')
  }
}

export type SignatureProblem = 'unknown-key' | 'bad-signature'

/** The trusted key that made `sig` over `manifestBytes`, or why there is none. */
export function checkSignature(
  manifestBytes: Uint8Array,
  sig: PackSignature,
  trusted: readonly TrustedKey[]
): { ok: true; key: TrustedKey } | { ok: false; problem: SignatureProblem } {
  const key = trusted.find((k) => k.keyId === sig.keyId)
  if (!key) return { ok: false, problem: 'unknown-key' }
  const valid = verify(null, manifestBytes, key.publicKey, Buffer.from(sig.signature, 'base64'))
  return valid ? { ok: true, key } : { ok: false, problem: 'bad-signature' }
}
