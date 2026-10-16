/**
 * Builds what Electron runs into build/: the main process (electron/main.ts
 * and the src/ it imports, one ESM file), the preload (CommonJS, as sandboxed
 * preloads must be), the page (electron/renderer: one browser bundle plus its
 * static files) and the tray icon. Dependencies stay in
 * node_modules: they are native, or loaded from disk (pdf.js fonts, the QVAC
 * worker).
 *
 *   npm run build:electron
 */
import { build, type Plugin } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { PROJECT_ROOT } from '../src/core/config.js'

const out = path.join(PROJECT_ROOT, 'build')

/** A speech bubble with two lines, as a macOS template image (black on transparent). */
const TRAY_SVG = (size: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 18 18">
  <path d="M3 3h12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 15 13H8l-4 3v-3H3a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 3 3z" fill="none" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M5 6.5h8M5 9.5h5" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>
</svg>`

const RENDERER = path.join(PROJECT_ROOT, 'electron/renderer')
const RENDERER_STATIC = ['index.html', 'styles.css', 'theme.js', 'recorder-worklet.js']

/**
 * The page reuses a few pure helpers from src/ (WAV encoding, the warning
 * texts). Their modules import `performance` from node:perf_hooks and, for
 * file loading the page never calls, node:fs/promises: give the browser
 * bundle stand-ins.
 */
const browserShims: Plugin = {
  name: 'browser-shims',
  setup(b) {
    b.onResolve({ filter: /^node:(perf_hooks|fs\/promises)$/ }, (a) => ({ path: a.path, namespace: 'shim' }))
    b.onLoad({ filter: /.*/, namespace: 'shim' }, (a) => ({
      contents: a.path === 'node:perf_hooks' ? 'export const performance = globalThis.performance' : 'export default {}',
      loader: 'js'
    }))
  }
}

/** The page: app.js and its static files into `outDir`. */
export async function buildRenderer(outDir: string, opts: { sourcemap?: boolean } = {}): Promise<void> {
  await fs.mkdir(outDir, { recursive: true })
  await build({
    entryPoints: [path.join(RENDERER, 'src/main.ts')],
    outfile: path.join(outDir, 'app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    sourcemap: opts.sourcemap ? 'linked' : false,
    plugins: [browserShims],
    logLevel: 'warning'
  })
  for (const f of RENDERER_STATIC) await fs.copyFile(path.join(RENDERER, f), path.join(outDir, f))
}

export async function buildElectron(): Promise<void> {
  await fs.rm(out, { recursive: true, force: true })
  await fs.mkdir(path.join(out, 'renderer'), { recursive: true })
  const common = { bundle: true, platform: 'node', target: 'node22', packages: 'external', sourcemap: 'linked', logLevel: 'warning' } as const
  await build({ ...common, entryPoints: [path.join(PROJECT_ROOT, 'electron/main.ts')], outfile: path.join(out, 'main.mjs'), format: 'esm' })
  await build({ ...common, entryPoints: [path.join(PROJECT_ROOT, 'electron/preload.ts')], outfile: path.join(out, 'preload.cjs'), format: 'cjs' })
  await buildRenderer(path.join(out, 'renderer'), { sourcemap: true })
  await sharp(Buffer.from(TRAY_SVG(18))).png().toFile(path.join(out, 'trayTemplate.png'))
  await sharp(Buffer.from(TRAY_SVG(36))).png().toFile(path.join(out, 'trayTemplate@2x.png'))
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  await buildElectron()
  console.log(`Built ${path.relative(process.cwd(), out)}/`)
}
