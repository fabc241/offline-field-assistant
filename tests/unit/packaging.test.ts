import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isDevelopmentBuild, releaseProblems } from '../../src/app/release-policy.js'
import { APP_HOME, loadConfig } from '../../src/core/config.js'
import { generateSigningKey, trustedKey } from '../../src/features/packs/signing.js'
import { TRUSTED_PACK_KEYS } from '../../src/features/packs/trusted-keys.js'
import { TRUSTED_LICENSE_KEYS } from '../../src/features/platform/license-keys.js'
import { isMachO, signables } from '../../scripts/macos-sign.js'

let tmp: string
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-packaging-'))
})
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const vendor = (label: string) => trustedKey(label, generateSigningKey().publicKeyPem)
const IDENTITY = 'Developer ID Application: Example Health NGO (AB12CD34EF)'

describe('release policy', () => {
  it('passes a Developer ID build with a notary profile and vendor keys', () => {
    expect(releaseProblems({ identity: IDENTITY, notaryProfile: 'ofa-notary', packKeys: [vendor('Vendor pack key 2027')], licenseKeys: [vendor('Vendor license key 2027')] })).toEqual([])
  })

  it('refuses this tree as it is: no identity, no notary profile, development keys', () => {
    const problems = releaseProblems({ packKeys: TRUSTED_PACK_KEYS, licenseKeys: TRUSTED_LICENSE_KEYS })
    expect(problems.join('\n')).toMatch(/OFA_SIGN_IDENTITY is not set/)
    expect(problems.join('\n')).toMatch(/OFA_NOTARY_PROFILE is not set/)
    expect(problems.filter((p) => /development key/.test(p))).toHaveLength(2)
    expect(isDevelopmentBuild([...TRUSTED_PACK_KEYS, ...TRUSTED_LICENSE_KEYS])).toBe(true)
  })

  it('refuses ad hoc, Apple Development and lookalike identities, and empty key lists', () => {
    for (const identity of ['-', 'Apple Development: Someone (AB12CD34EF)', 'Developer ID Application: Someone', 'Developer ID Installer: X (AB12CD34EF)']) {
      expect(releaseProblems({ identity, notaryProfile: 'p', packKeys: [vendor('v')], licenseKeys: [vendor('v')] }), identity).toHaveLength(1)
    }
    expect(releaseProblems({ identity: IDENTITY, notaryProfile: 'p', packKeys: [], licenseKeys: [vendor('v')] })).toEqual([
      'No pack keys are trusted (src/features/packs/trusted-keys.ts)'
    ])
  })
})

describe('Forge packaging', () => {
  const config = createRequire(import.meta.url)('../../forge.config.cjs') as { packagerConfig: { ignore: (f: string) => boolean; extendInfo: Record<string, unknown> } }
  const ignore = config.packagerConfig.ignore

  it('ships only the bundled app, production modules and the QVAC worker', () => {
    for (const kept of ['', '/package.json', '/build', '/build/main.mjs', '/build/preload.cjs', '/build/renderer/index.html', '/node_modules/sharp/package.json', '/qvac/worker.entry.mjs', '/qvac.config.json']) {
      expect(ignore(kept), kept).toBe(false)
    }
    for (const dropped of ['/models', '/models/manifest.json', '/src/cli/ofa.ts', '/keys/ofa-dev-2026.key.pem', '/var/license/dev.ofalicense', '/eval', '/tests', '/out', '/build/main.mjs.map', '/node_modules/.bin/tsx', '/Option3_Offline_Field_Assistant.docx', '/README.md']) {
      expect(ignore(dropped), dropped).toBe(true)
    }
  })

  it('is a Dock app that explains its microphone and camera use', () => {
    expect(config.packagerConfig.extendInfo).toMatchObject({ LSUIElement: false })
    expect(String(config.packagerConfig.extendInfo.NSMicrophoneUsageDescription)).toMatch(/on this Mac only/)
    expect(String(config.packagerConfig.extendInfo.NSCameraUsageDescription)).toMatch(/on this Mac only/)
  })

  it('grants the hardened-runtime exceptions the engines need and nothing broader', async () => {
    const plist = await fs.readFile(path.join(import.meta.dirname, '../../electron/entitlements.plist'), 'utf8')
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])
    expect(keys.sort()).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
      'com.apple.security.device.audio-input',
      'com.apple.security.device.camera'
    ])
  })
})

describe('inside-out signing order', () => {
  it('finds Mach-O files by their magic and signs files before bundles, deepest first', async () => {
    const app = path.join(tmp, 'X.app')
    const write = async (rel: string, bytes: number[]) => {
      await fs.mkdir(path.dirname(path.join(app, rel)), { recursive: true })
      await fs.writeFile(path.join(app, rel), Buffer.from([...bytes, 0, 0, 0, 0]))
    }
    const thin64 = [0xcf, 0xfa, 0xed, 0xfe]
    const fat = [0xca, 0xfe, 0xba, 0xbe]
    await write('Contents/MacOS/x', thin64)
    await write('Contents/Frameworks/Y.framework/Versions/A/Y', fat)
    await write('Contents/Frameworks/Y Helper.app/Contents/MacOS/Y Helper', thin64)
    await write('Contents/Resources/app/node_modules/addon/prebuilds/darwin-arm64/addon.bare', thin64)
    await write('Contents/Resources/app/node_modules/addon/index.js', [0x2f, 0x2f, 0x20, 0x6a])
    await write('Contents/Info.plist', [0x3c, 0x3f, 0x78, 0x6d])
    await fs.symlink('Versions/A/Y', path.join(app, 'Contents/Frameworks/Y.framework/Y'))

    expect(await isMachO(path.join(app, 'Contents/MacOS/x'))).toBe(true)
    expect(await isMachO(path.join(app, 'Contents/Info.plist'))).toBe(false)
    const { files, bundles } = await signables(app)
    const rel = (p: string) => path.relative(app, p)
    expect(files.map(rel)).toEqual([
      'Contents/Resources/app/node_modules/addon/prebuilds/darwin-arm64/addon.bare',
      'Contents/Frameworks/Y Helper.app/Contents/MacOS/Y Helper',
      'Contents/Frameworks/Y.framework/Versions/A/Y',
      'Contents/MacOS/x'
    ])
    expect(bundles.map(rel)).toEqual(['Contents/Frameworks/Y Helper.app', 'Contents/Frameworks/Y.framework'])
  })
})

describe('app home', () => {
  it('keeps everything under OFA_HOME, and the dev layout without it', () => {
    const app = loadConfig({ OFA_HOME: '/tmp/ofa-home' })
    expect(app).toMatchObject({
      dataDir: '/tmp/ofa-home',
      modelsDir: '/tmp/ofa-home/models',
      packsDir: '/tmp/ofa-home/packs',
      logDir: '/tmp/ofa-home/logs',
      licenseFile: '/tmp/ofa-home/license/license.ofalicense'
    })
    expect(loadConfig({ OFA_HOME: '/tmp/ofa-home', OFA_MODELS_DIR: '/Volumes/USB/models' }).modelsDir).toBe('/Volumes/USB/models')
    const dev = loadConfig({})
    expect(dev.modelsDir.endsWith('/models')).toBe(true)
    expect(dev.packsDir.endsWith('/var/packs')).toBe(true)
    expect(APP_HOME.endsWith('Library/Application Support/OfflineFieldAssistant')).toBe(true)
  })
})
