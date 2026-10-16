/**
 * Signs a packaged .app inside out with the hardened runtime: every Mach-O
 * file first (dylibs, the .node and .bare add-ons, the Bare worker, helper
 * executables), then each nested bundle (frameworks, helper apps), deepest
 * first, then the app itself. Every signature carries electron/entitlements.plist.
 *
 * With a Developer ID identity the signatures are timestamped, as
 * notarization requires. Without one the app is signed ad hoc ("-"): the
 * hardened runtime and the entitlements still apply, so a local run proves
 * the app works under them, but Gatekeeper will not open it on another Mac.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const MACH_O = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca])

export interface SignOptions {
  /** "Developer ID Application: Name (TEAMID)", or "-" for ad hoc. */
  identity: string
  entitlements: string
  onFile?: (file: string) => void
}

export interface SignResult {
  files: number
  bundles: number
  ms: number
}

export async function isMachO(file: string): Promise<boolean> {
  const fh = await fs.open(file, 'r')
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(4), 0, 4, 0)
    return bytesRead === 4 && MACH_O.has(buffer.readUInt32BE(0))
  } finally {
    await fh.close()
  }
}

/** Mach-O files and nested bundles under `app`, symlinks skipped. */
export async function signables(app: string): Promise<{ files: string[]; bundles: string[] }> {
  const files: string[] = []
  const bundles: string[] = []
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walk(p)
        if (/\.(app|framework)$/.test(entry.name)) bundles.push(p)
      } else if (entry.isFile() && (await isMachO(p))) {
        files.push(p)
      }
    }
  }
  await walk(app)
  const deepestFirst = (a: string, b: string) => b.split(path.sep).length - a.split(path.sep).length || a.localeCompare(b)
  return { files: files.sort(deepestFirst), bundles: bundles.sort(deepestFirst) }
}

export async function signApp(app: string, opts: SignOptions): Promise<SignResult> {
  const t0 = performance.now()
  const adHoc = opts.identity === '-'
  const args = ['--force', '--sign', opts.identity, '--options', 'runtime', '--entitlements', opts.entitlements, adHoc ? '--timestamp=none' : '--timestamp']
  const { files, bundles } = await signables(app)
  for (const file of [...files, ...bundles, app]) {
    opts.onFile?.(file)
    await exec('/usr/bin/codesign', [...args, file])
  }
  return { files: files.length, bundles: bundles.length, ms: performance.now() - t0 }
}

export interface SignatureCheck {
  /** codesign --verify --deep --strict passed. */
  valid: boolean
  /** Every Mach-O file has the hardened runtime flag. */
  hardened: boolean
  /** Files without it. */
  notHardened: string[]
  entitlements: string[]
  identity: string
  /** spctl's verdict; only a notarized Developer ID app is accepted. */
  gatekeeper: string
}

export async function checkSignatures(app: string): Promise<SignatureCheck> {
  const verify = await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]).then(
    () => true,
    () => false
  )
  const { files } = await signables(app)
  const notHardened: string[] = []
  for (const file of files) {
    const { stderr } = await exec('/usr/bin/codesign', ['-dv', file]).catch((e: { stderr: string }) => ({ stderr: e.stderr }))
    if (!/flags=0x[0-9a-f]*\(.*runtime.*\)/.test(stderr)) notHardened.push(path.relative(app, file))
  }
  const { stdout: ent } = await exec('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', app]).catch(() => ({ stdout: '' }))
  const { stderr: info } = await exec('/usr/bin/codesign', ['-dvv', app]).catch((e: { stderr: string }) => ({ stderr: e.stderr }))
  const gatekeeper = await exec('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', app]).then(
    (r) => r.stderr.trim(),
    (e: { stderr: string }) => e.stderr.trim()
  )
  return {
    valid: verify,
    hardened: notHardened.length === 0,
    notHardened,
    entitlements: [...ent.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]!),
    identity: /Authority=([^\n]+)/.exec(info)?.[1] ?? (/Signature=adhoc/.test(info) ? 'ad hoc' : 'unknown'),
    gatekeeper
  }
}
