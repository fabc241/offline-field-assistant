/**
 * Packages the arm64 app: bundle the main process, package with Electron
 * Forge and the QVAC plugin, sign inside out with the hardened runtime,
 * check the signatures, and zip it with ditto (the format notarytool takes).
 *
 *   npm run package            development build: Developer ID if OFA_SIGN_IDENTITY is set, else ad hoc
 *   npm run package:release    release: needs OFA_SIGN_IDENTITY (Developer ID Application),
 *                              OFA_NOTARY_PROFILE (xcrun notarytool store-credentials) and the
 *                              vendor's release keys in place of the development keys; notarizes
 *                              and staples
 *
 * Writes out/Offline Field Assistant-darwin-arm64/ and out/offline-field-assistant-<version>-arm64.zip,
 * and out/package-report.json.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isDevelopmentBuild, releaseProblems } from '../src/app/release-policy.js'
import { PROJECT_ROOT } from '../src/core/config.js'
import { TRUSTED_PACK_KEYS } from '../src/features/packs/trusted-keys.js'
import { TRUSTED_LICENSE_KEYS } from '../src/features/platform/license-keys.js'
import pkg from '../package.json' with { type: 'json' }
import { buildElectron } from './build-electron.js'
import { checkSignatures, signApp } from './macos-sign.js'

const exec = promisify(execFile)
const release = process.argv.includes('--release')
const OUT = path.join(PROJECT_ROOT, 'out')
export const APP_DIR = path.join(OUT, 'Offline Field Assistant-darwin-arm64')
export const APP = path.join(APP_DIR, 'Offline Field Assistant.app')
export const ZIP = path.join(OUT, `offline-field-assistant-${pkg.version}-arm64.zip`)

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now()
  process.stderr.write(`${label} … `)
  const r = await fn()
  process.stderr.write(`${((performance.now() - t0) / 1000).toFixed(1)} s\n`)
  return r
}

async function dirBytes(dir: string): Promise<number> {
  const { stdout } = await exec('/usr/bin/du', ['-sk', dir])
  return Number(stdout.split('\t')[0]) * 1024
}

async function main() {
  const identity = process.env.OFA_SIGN_IDENTITY || '-'
  const notaryProfile = process.env.OFA_NOTARY_PROFILE
  if (release) {
    const problems = releaseProblems({ identity: process.env.OFA_SIGN_IDENTITY, notaryProfile, packKeys: TRUSTED_PACK_KEYS, licenseKeys: TRUSTED_LICENSE_KEYS })
    if (problems.length) {
      console.error('✖ Not a release build:')
      for (const p of problems) console.error(`  • ${p}`)
      process.exit(1)
    }
  }
  const t0 = performance.now()
  await step('Bundling the main process', buildElectron)
  await fs.rm(APP_DIR, { recursive: true, force: true })
  await step('Packaging (Electron Forge + QVAC plugin)', () =>
    exec(path.join(PROJECT_ROOT, 'node_modules/.bin/electron-forge'), ['package', '--arch=arm64', '--platform=darwin'], { cwd: PROJECT_ROOT, maxBuffer: 64 * 1024 * 1024 })
  )
  const signed = await step(`Signing (${identity === '-' ? 'ad hoc' : identity}, hardened runtime)`, () =>
    signApp(APP, { identity, entitlements: path.join(PROJECT_ROOT, 'electron/entitlements.plist') })
  )
  const check = await step('Checking signatures', () => checkSignatures(APP))
  if (!check.valid || !check.hardened) {
    console.error(`✖ Signature check failed: valid ${check.valid}, not hardened: ${check.notHardened.join(', ')}`)
    process.exit(1)
  }
  await fs.rm(ZIP, { force: true })
  let notarized = false
  if (release) {
    await step('Zipping for notarization', () => exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', APP, ZIP]))
    await step('Notarizing (notarytool, waits for Apple)', () =>
      exec('/usr/bin/xcrun', ['notarytool', 'submit', ZIP, '--keychain-profile', notaryProfile!, '--wait'], { maxBuffer: 16 * 1024 * 1024 })
    )
    await step('Stapling the ticket', () => exec('/usr/bin/xcrun', ['stapler', 'staple', APP]))
    await fs.rm(ZIP, { force: true })
    notarized = true
  }
  await step('Zipping', () => exec('/usr/bin/ditto', ['-c', '-k', '--keepParent', APP, ZIP]))
  const gatekeeper = notarized ? (await checkSignatures(APP)).gatekeeper : check.gatekeeper

  const report = {
    version: pkg.version,
    kind: release ? 'release' : 'development',
    developmentKeys: isDevelopmentBuild([...TRUSTED_PACK_KEYS, ...TRUSTED_LICENSE_KEYS]),
    app: path.relative(PROJECT_ROOT, APP),
    zip: path.relative(PROJECT_ROOT, ZIP),
    appBytes: await dirBytes(APP),
    zipBytes: (await fs.stat(ZIP)).size,
    signed: { identity: check.identity, files: signed.files, bundles: signed.bundles, entitlements: check.entitlements, hardened: check.hardened },
    notarized,
    gatekeeper,
    totalMs: Math.round(performance.now() - t0)
  }
  await fs.writeFile(path.join(OUT, 'package-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`\n${report.kind} build ${report.version}: ${(report.appBytes / 1024 ** 2).toFixed(0)} MB app, ${(report.zipBytes / 1024 ** 2).toFixed(0)} MB zip`)
  console.log(`  signed      ${check.identity}, ${signed.files} Mach-O files and ${signed.bundles} bundles, hardened runtime`)
  console.log(`  gatekeeper  ${gatekeeper.split('\n')[0]}`)
  if (report.developmentKeys) console.log('  ⚠ trusts the development pack and license keys: not for release')
  console.log(`→ ${report.zip}`)
}

await main()
