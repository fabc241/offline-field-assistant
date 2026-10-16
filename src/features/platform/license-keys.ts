/**
 * Public keys whose licenses this app accepts: the vendor's, compiled in.
 * They are kept apart from the pack keys, so whoever signs content cannot
 * also issue licenses.
 *
 * The development key's private half is keys/ofa-license-dev-2026.key.pem on
 * the dev machine (git-ignored); replace it with the vendor's release key
 * before any device leaves the building: `npm run package:release` refuses
 * any key labelled "not for release".
 */
import { trustedKey, type TrustedKey } from '../packs/signing.js'

export const TRUSTED_LICENSE_KEYS: readonly TrustedKey[] = [
  trustedKey(
    'OFA development license key 2026 (not for release)',
    `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA2HFeqiJadN08IOgUyCB950eE+4/XPmYtgzNyfEB91VE=
-----END PUBLIC KEY-----
`
  )
]
