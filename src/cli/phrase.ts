import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { AppConfig } from '../core/config.js'
import { isLang, type Lang } from '../core/engines.js'
import { PackError, PackLoader } from '../features/packs/loader.js'
import { PackStore } from '../features/packs/store.js'
import { TRUSTED_PACK_KEYS } from '../features/packs/trusted-keys.js'
import { Phrasebook, type PhraseEntry } from '../features/phrasebook/phrasebook.js'
import { playWav } from './player.js'

const USAGE = `Usage:
  ofa phrase list [--category C] [--json]                     phrases of the installed pack
  ofa phrase search --lang en|sw [--limit N] [--json] "text"  keyword search in that language
  ofa phrase play --lang en|sw [--out FILE.wav] [--no-play] ID
                                                              play a phrase's recording as it is in the pack
Every command takes --pack ID when more than one pack is installed (ofa pack list).`

const SYNTHETIC_NOTE = 'synthetic placeholder (text-to-speech), not a native speaker'

type Sub = (open: (packId: string | undefined) => Promise<Phrasebook>, args: string[]) => Promise<boolean>

const PACK_OPTION = { pack: { type: 'string' } } as const

export async function phraseCommand(config: AppConfig, args: string[]): Promise<boolean> {
  const [sub, ...rest] = args
  const run = sub ? subcommands[sub] : undefined
  if (!run) return usage()
  try {
    return await run((packId) => openPhrasebook(config, packId), rest)
  } catch (err) {
    if (!(err instanceof PackError)) throw err
    console.error(`✖ Pack refused (${err.problem}): ${err.message}`)
    return false
  }
}

/** Loads (and verifies) the installed pack; no model is needed. */
async function openPhrasebook(config: AppConfig, packId: string | undefined): Promise<Phrasebook> {
  const store = new PackStore(config.packsDir, new PackLoader({ trustedKeys: TRUSTED_PACK_KEYS }))
  if (!packId) {
    const installed = await store.list()
    if (!installed.length) throw new Error(`No packs installed in ${config.packsDir}; install one with ofa pack install`)
    if (installed.length > 1) throw new Error(`${installed.length} packs are installed (${installed.map((p) => p.id).join(', ')}); choose one with --pack`)
    packId = installed[0]!.id
  }
  return new Phrasebook(await store.load(packId))
}

const subcommands: Record<string, Sub> = {
  async list(open, args) {
    const { values } = parseArgs({ args, options: { ...PACK_OPTION, category: { type: 'string' }, json: { type: 'boolean', default: false } } })
    const book = await open(values.pack)
    const phrases = book.list(values.category)
    if (values.category && !phrases.length) {
      console.error(`✖ No category "${values.category}"; categories: ${book.categories().join(', ')}`)
      return false
    }
    if (values.json) return printJson(phrases)
    header(book)
    for (const category of book.categories()) {
      const inCategory = phrases.filter((p) => p.category === category)
      if (!inCategory.length) continue
      console.log(`\n${category}`)
      for (const p of inCategory) printPhrase(p)
    }
    return true
  },

  async search(open, args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { ...PACK_OPTION, lang: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean', default: false } }
    })
    const lang = values.lang
    const limit = values.limit === undefined ? 5 : Number(values.limit)
    const query = positionals.join(' ')
    if (!lang || !isLang(lang) || !query.trim() || !(Number.isInteger(limit) && limit > 0)) return usage()
    const book = await open(values.pack)
    const hits = book.search(query, lang, { limit })
    if (values.json) return printJson(hits)
    header(book)
    if (!hits.length) console.log(`\nNo phrase matches "${query}".`)
    for (const { phrase, score } of hits) printPhrase(phrase, `${score.toFixed(2)}  `)
    return true
  },

  async play(open, args) {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { ...PACK_OPTION, lang: { type: 'string' }, out: { type: 'string' }, 'no-play': { type: 'boolean', default: false } }
    })
    const [id] = positionals
    const lang = values.lang
    if (!id || positionals.length > 1 || !lang || !isLang(lang)) return usage()
    const book = await open(values.pack)
    const phrase = book.get(id)
    if (!phrase) {
      console.error(`✖ No phrase "${id}" in ${book.packId}; see ofa phrase list`)
      return false
    }
    const recording = phrase.recordings[lang]
    header(book)
    console.log(`\n▶ ${phrase.id} (${lang}): ${phrase.text[lang]}`)
    console.log(`  ${otherLang(lang)}: ${phrase.text[otherLang(lang)]}`)
    console.log(`  vetted by: ${phrase.vettedBy}`)
    if (recording.synthetic) console.log(`  ⚠ ${SYNTHETIC_NOTE}`)
    const wav = book.recording(id, lang)
    if (values.out) {
      await fs.mkdir(path.dirname(path.resolve(values.out)), { recursive: true })
      await fs.writeFile(values.out, wav)
      console.log(`  → ${values.out}`)
    }
    if (!values['no-play']) await playWav(wav)
    return true
  }
}

const otherLang = (lang: Lang): Lang => (lang === 'en' ? 'sw' : 'en')

function header(book: Phrasebook) {
  console.log(`${book.packId} ${book.packVersion}${book.notice ? `  ⚠ ${book.notice}` : ''}`)
}

function printPhrase(p: PhraseEntry, prefix = '') {
  const synthetic = p.recordings.en.synthetic || p.recordings.sw.synthetic
  console.log(`  ${prefix}${p.id.padEnd(20)} ${p.text.en}  |  ${p.text.sw}${synthetic ? '  (synthetic audio)' : ''}`)
}

function printJson(value: unknown): true {
  console.log(JSON.stringify(value, null, 2))
  return true
}

function usage(): false {
  console.error(USAGE)
  return false
}
