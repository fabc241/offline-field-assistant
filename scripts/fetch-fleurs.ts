/**
 * Dev-time, online: a subset of the FLEURS test split (google/fleurs,
 * CC-BY-4.0) for the speech-to-text eval, into var/eval-audio/fleurs-<lang>/.
 *
 *   npm run fetch-fleurs [-- --count 150]
 *
 * The test archives are 290–330 MB; this streams each one and stops after
 * `count` clips, keeping one speaker per sentence so every clip is new text.
 * The dataset is pinned to a commit.
 */
import { createGunzip } from 'node:zlib'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { parseArgs } from 'node:util'
import type { Lang } from '../src/core/engines.js'
import { EVAL_AUDIO_DIR, readSet, writeSet, type Clip } from '../eval/audio-sets.js'

const REVISION = '70bb2e84b976b7e960aa89f1c648e09c59f894dd'
const BASE = `https://huggingface.co/datasets/google/fleurs/resolve/${REVISION}/data`
const LOCALES: Record<Lang, string> = { sw: 'sw_ke', en: 'en_us' }

const { values } = parseArgs({ options: { count: { type: 'string', default: '150' } } })
const count = Number(values.count)

for (const [lang, locale] of Object.entries(LOCALES) as [Lang, string][]) {
  const set = `fleurs-${lang}`
  const dir = path.join(EVAL_AUDIO_DIR, set)
  if (((await readSet(set))?.length ?? 0) >= count) {
    console.log(`✓ ${set} already present`)
    continue
  }
  await fs.mkdir(dir, { recursive: true })

  // test.tsv columns: sentence id, file name, raw transcription, normalized, phonemes, samples, gender
  const tsv = await (await get(`${BASE}/${locale}/test.tsv`)).text()
  const rows = new Map(
    tsv
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .map(([sentence, file, raw]) => [file!, { sentence: sentence!, text: raw! }])
  )

  const clips: Clip[] = []
  const sentences = new Set<string>()
  const abort = new AbortController()
  const res = await get(`${BASE}/${locale}/audio/test.tar.gz`, abort.signal)
  const body = Readable.fromWeb(res.body as NodeReadableStream)
  const gunzip = createGunzip()
  // pipe() does not forward errors; stopping early (abort) is not one.
  body.on('error', (err) => abort.signal.aborted || gunzip.destroy(err))
  try {
    for await (const { name, data } of tarEntries(body.pipe(gunzip))) {
      const file = path.basename(name)
      const row = rows.get(file)
      if (!file.endsWith('.wav') || !row || sentences.has(row.sentence)) continue
      sentences.add(row.sentence)
      const target = path.join(dir, file)
      await fs.writeFile(target, data)
      clips.push({ id: `${lang}-${row.sentence}`, lang, file: target, text: row.text })
      if (clips.length >= count) break
    }
  } finally {
    abort.abort()
    gunzip.destroy()
  }
  await writeSet(set, clips)
  console.log(`✓ ${set}: ${clips.length} clips from ${sentences.size} sentences`)
}
process.exit(0)

async function get(url: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, { redirect: 'follow', signal })
  if (!res.ok || !res.body) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`)
  return res
}

/** Minimal streaming tar reader: regular files only, with GNU long names and pax paths. */
async function* tarEntries(stream: AsyncIterable<Buffer>): AsyncGenerator<{ name: string; data: Buffer }> {
  let buf = Buffer.alloc(0)
  let longName: string | undefined
  const chunks = stream[Symbol.asyncIterator]()
  const need = async (n: number) => {
    while (buf.length < n) {
      const next = await chunks.next()
      if (next.done) return false
      buf = Buffer.concat([buf, next.value])
    }
    return true
  }
  for (;;) {
    if (!(await need(512))) return
    const header = buf.subarray(0, 512)
    if (header.every((b) => b === 0)) return
    const field = (start: number, len: number) => header.toString('utf8', start, start + len).replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1) || '0'
    const prefix = field(345, 155)
    const padded = Math.ceil(size / 512) * 512
    if (!(await need(512 + padded))) return
    const data = Buffer.from(buf.subarray(512, 512 + size))
    buf = buf.subarray(512 + padded)

    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '')
    } else if (type === 'x') {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? longName
    } else {
      const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
      longName = undefined
      if (type === '0') yield { name, data }
    }
  }
}
