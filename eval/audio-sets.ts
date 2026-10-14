/**
 * Speech eval sets live outside git, in var/eval-audio/<set>/: WAV files plus
 * an index.csv of `id,lang,file,text`. Fetched or rendered by dev scripts.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { PROJECT_ROOT } from '../src/core/config.js'
import { isLang, type Lang } from '../src/core/engines.js'
import { parseCsv, toCsv } from './csv.js'

export const EVAL_AUDIO_DIR = path.join(PROJECT_ROOT, 'var/eval-audio')

export interface Clip {
  id: string
  lang: Lang
  /** Absolute path of the WAV file. */
  file: string
  /** Reference transcript. */
  text: string
}

export async function readSet(name: string): Promise<Clip[] | undefined> {
  const dir = path.join(EVAL_AUDIO_DIR, name)
  const raw = await fs.readFile(path.join(dir, 'index.csv'), 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  return parseCsv(raw).map((r) => {
    if (!isLang(r.lang!)) throw new Error(`${name}/index.csv: bad lang "${r.lang}" for ${r.id}`)
    return { id: r.id!, lang: r.lang, file: path.join(dir, r.file!), text: r.text! }
  })
}

export async function writeSet(name: string, clips: Clip[]): Promise<void> {
  const dir = path.join(EVAL_AUDIO_DIR, name)
  await fs.writeFile(
    path.join(dir, 'index.csv'),
    toCsv(clips.map((c) => ({ id: c.id, lang: c.lang, file: path.relative(dir, c.file), text: c.text })))
  )
}
