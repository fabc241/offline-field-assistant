import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { AppConfig } from '../core/config.js'
import { DEVICE_ID, deviceId } from '../features/platform/device.js'
import { TRUSTED_LICENSE_KEYS } from '../features/platform/license-keys.js'
import {
  LICENSE_FEATURES,
  READ_ONLY_FEATURES,
  allows,
  checkLicense,
  issueLicense,
  type License,
  type LicenseFeature,
  type LicenseState
} from '../features/platform/license.js'
import { loadPrivateKey } from '../features/packs/signing.js'
import { writeKeyPair } from './pack.js'
import type { Session } from './session.js'

const USAGE = `Usage:
  ofa license show [--json]                    the installed license and what it allows
  ofa license device-id                        this device's id, for a license bound to it
  ofa license install FILE                     check FILE and make it this device's license
Vendor only:
  ofa license keygen --out keys/NAME           new Ed25519 license-signing key
  ofa license issue --key FILE --id ID --licensee NAME --seats N --expiry YYYY-MM-DD
                    [--features a,b,…|all] [--device ID] [--out FILE]
                                               sign a license (expiry: valid through that day, UTC)
Features: ${LICENSE_FEATURES.join(', ')}. ${READ_ONLY_FEATURES.join(' and ')} are always available.
Keys: OFA_LICENSE_KEY can stand in for --key; OFA_PACK_KEY_PASSPHRASE decrypts an encrypted key.`

type Sub = (config: AppConfig, args: string[], session: Session) => Promise<boolean>

export async function licenseCommand(config: AppConfig, args: string[], session: Session): Promise<boolean> {
  const [sub, ...rest] = args
  const run = sub ? subcommands[sub] : undefined
  if (!run) return usage()
  return run(config, rest, session)
}

const subcommands: Record<string, Sub> = {
  async show(config, args, session) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false } } })
    const state = session.license
    if (values.json) {
      console.log(JSON.stringify({ file: config.licenseFile, ...state }, null, 2))
      return true
    }
    printState(state, config.licenseFile)
    return true
  },

  async 'device-id'() {
    const id = await deviceId()
    if (!id) {
      console.error('✖ The device id cannot be read on this system')
      return false
    }
    console.log(id)
    return true
  },

  async install(config, args, session) {
    const { positionals } = parseArgs({ args, allowPositionals: true })
    const [file] = positionals
    if (!file || positionals.length > 1) return usage()
    const text = await fs.readFile(file, 'utf8')
    const state = checkLicense(text, { trustedKeys: TRUSTED_LICENSE_KEYS, deviceId: session.license.deviceId })
    if (state.status !== 'valid') {
      console.error(`✖ Not installed. ${state.message.replace(/: read-only.*$/, '')}.`)
      await session.activity.record({ feature: 'license', action: 'install', outcome: 'refused', reason: `license-${state.problem ?? state.status}` })
      return false
    }
    await fs.mkdir(path.dirname(config.licenseFile), { recursive: true })
    const tmp = `${config.licenseFile}.${process.pid}.tmp`
    await fs.writeFile(tmp, text)
    await fs.rename(tmp, config.licenseFile)
    await session.activity.record({ feature: 'license', action: 'install', outcome: 'ok', detail: { license: state.license!.id } })
    console.log(`Installed ${config.licenseFile}`)
    printState(state)
    return true
  },

  async keygen(_config, args) {
    const { values } = parseArgs({ args, options: { out: { type: 'string' } } })
    if (!values.out) return usage()
    await writeKeyPair(values.out, 'Devices accept licenses signed with this key once the public key is in src/features/platform/license-keys.ts.')
    return true
  },

  async issue(_config, args) {
    const { values } = parseArgs({
      args,
      options: {
        key: { type: 'string' },
        id: { type: 'string' },
        licensee: { type: 'string' },
        seats: { type: 'string' },
        expiry: { type: 'string' },
        features: { type: 'string', default: 'all' },
        device: { type: 'string' },
        out: { type: 'string' }
      }
    })
    const keyFile = values.key ?? process.env.OFA_LICENSE_KEY
    const { id, licensee, expiry } = values
    const seats = Number(values.seats)
    if (!keyFile || !id || !licensee || !expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !(Number.isInteger(seats) && seats > 0)) return usage()
    const features = values.features === 'all' ? [...LICENSE_FEATURES] : values.features.split(',').map((f) => f.trim())
    const unknown = features.filter((f) => !(LICENSE_FEATURES as readonly string[]).includes(f))
    if (unknown.length) {
      console.error(`✖ Unknown features: ${unknown.join(', ')} (known: ${LICENSE_FEATURES.join(', ')})`)
      return false
    }
    if (values.device && !DEVICE_ID.test(values.device)) {
      console.error('✖ --device must look like XXXX-XXXX-XXXX-XXXX (ofa license device-id on that device)')
      return false
    }
    const license: License = {
      format: 1,
      kind: 'license',
      id,
      licensee,
      seats,
      issued: new Date().toISOString(),
      expiry: `${expiry}T23:59:59.999Z`,
      features: features as LicenseFeature[],
      ...(values.device ? { deviceId: values.device } : {})
    }
    const key = loadPrivateKey(await fs.readFile(keyFile, 'utf8'), process.env.OFA_PACK_KEY_PASSPHRASE || undefined)
    const text = issueLicense(license, key)
    const out = values.out ?? `${id}.ofalicense`
    await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true })
    await fs.writeFile(out, text, { flag: 'wx' })
    const state = checkLicense(text, { trustedKeys: TRUSTED_LICENSE_KEYS, ...(values.device ? { deviceId: values.device } : {}) })
    console.log(`Issued ${out}`)
    printState(state)
    if (state.problem === 'unknown-key') console.log('⚠ This app does not trust that key: devices will refuse the license.')
    return true
  }
}

function printState(state: LicenseState, file?: string) {
  const l = state.license
  console.log(`${state.mode === 'full' ? '✓' : '⚠'} ${state.message}`)
  if (file) console.log(`  file        ${file}`)
  if (l) {
    console.log(`  license     ${l.id}, ${l.seats} seat${l.seats > 1 ? 's' : ''}, issued ${l.issued.slice(0, 10)}`)
    console.log(`  device      ${l.deviceId ?? 'any'}`)
    console.log(`  signed by   ${state.signedBy!.label} (${state.signedBy!.keyId})`)
  }
  const usable = LICENSE_FEATURES.filter((f) => allows(state, f))
  console.log(`  available   ${usable.join(', ')}`)
  for (const w of state.warnings) console.log(`  ⚠ ${w === 'expires-soon' ? 'expires soon: ask for a new license file' : "this computer's clock is before the issue date"}`)
}

function usage(): false {
  console.error(USAGE)
  return false
}
