/**
 * Shows the app's page in a browser with sample data, without Electron or
 * the models: the page as built for the app, plus a stand-in `window.ofa`
 * (electron/renderer/preview/mock.ts) fed from content/sample.
 *
 *   npm run ui:preview            http://localhost:5178
 *   …/?license=read-only  ?models=missing  ?pack=none   other states
 *
 * Writes to var/ui-preview/ only; nothing here is packaged.
 */
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { PROJECT_ROOT } from '../src/core/config.js'
import { parseCsv } from '../src/core/csv.js'
import { buildRenderer } from './build-electron.js'

const out = path.join(PROJECT_ROOT, 'var/ui-preview')
const sampleDir = path.join(PROJECT_ROOT, 'content/sample')
const PORT = Number(process.env.PORT ?? 5178)

async function sampleData() {
  const pack = JSON.parse(await fs.readFile(path.join(sampleDir, 'pack.json'), 'utf8'))
  const recordings = new Set(await fs.readdir(path.join(sampleDir, 'recordings')))
  const list = (s: string) => s.split('|').map((x) => x.trim()).filter(Boolean)
  const phrases = parseCsv(await fs.readFile(path.join(sampleDir, 'phrases.csv'), 'utf8')).map((r) => ({
    id: r.id!,
    category: r.category!,
    text: { en: r.en!, sw: r.sw! },
    vettedBy: r.vetted_by!,
    recordings: Object.fromEntries(
      (['en', 'sw'] as const).map((l) => [l, { path: `audio/${r.id}.${l}.wav`, synthetic: recordings.has(`${r.id}.${l}.wav.synthetic.json`) }])
    )
  }))
  const cards = parseCsv(await fs.readFile(path.join(sampleDir, 'cards.csv'), 'utf8')).map((r) => {
    const card = (l: 'en' | 'sw') => ({
      id: r.id!,
      lang: l,
      title: r[`title_${l}`]!,
      dangerSigns: list(r[`danger_signs_${l}`]!),
      steps: list(r[`steps_${l}`]!),
      source: r.source!,
      version: Number(r.version)
    })
    return { id: r.id!, en: card('en'), sw: card('sw'), tags: list(r.tags ?? '') }
  })
  return { pack, phrases, cards }
}

async function buildPreview() {
  await buildRenderer(out, { sourcemap: true })
  await build({
    entryPoints: [path.join(PROJECT_ROOT, 'electron/renderer/preview/mock.ts')],
    outfile: path.join(out, 'mock.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    define: { __SAMPLE__: JSON.stringify(await sampleData()) },
    logLevel: 'warning'
  })
  const html = await fs.readFile(path.join(out, 'index.html'), 'utf8')
  // The stand-in fetches the sample recordings; the app itself never fetches.
  const previewHtml = html
    .replace("worker-src 'self'", "worker-src 'self'; connect-src 'self'")
    .replace('<script src="app.js">', '<script src="mock.js"></script>\n    <script src="app.js">')
  await fs.writeFile(path.join(out, 'index.html'), previewHtml)
  await fs.cp(path.join(sampleDir, 'recordings'), path.join(out, 'recordings'), { recursive: true })
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
  '.map': 'application/json'
}

await buildPreview()
http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const file = path.join(out, rel)
    if (!file.startsWith(out + path.sep)) return void res.writeHead(403).end()
    // Rebuild on each page load, so an edit shows with a reload.
    if (rel === '/index.html') await buildPreview().catch((err) => console.error(err))
    try {
      const body = await fs.readFile(file)
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`UI preview on http://localhost:${PORT}`))
