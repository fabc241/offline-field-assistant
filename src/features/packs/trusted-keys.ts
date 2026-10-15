/**
 * Public keys whose packs this app accepts. They are compiled in, so a pack
 * cannot bring its own trust. The matching private keys never ship.
 *
 * The development key signs the placeholder sample pack. Its private half is
 * keys/ofa-dev-2026.key.pem on the dev machine (git-ignored); replace it with
 * the vendor's release key before any device leaves the building (F10).
 */
import { trustedKey, type TrustedKey } from './signing.js'

export const TRUSTED_PACK_KEYS: readonly TrustedKey[] = [
  trustedKey(
    'OFA development key 2026 (not for release)',
    `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA9Mpxp4EOTv1X3cFSeRPet8J4fsm+L+/R9m/NRYXmgMs=
-----END PUBLIC KEY-----
`
  )
]
