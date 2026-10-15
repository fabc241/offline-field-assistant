import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { MODEL_SPECS } from '../core/catalog.js'
import type { AppConfig } from '../core/config.js'
import { isLang, qvacEmbedder, qvacTranscriber, type Lang } from '../core/engines.js'
import { ModelStore } from '../core/model-store.js'
import { QvacRuntime, createSdkPort } from '../core/qvac.js'
import { Guide, type GuideCard, type GuideResult } from '../features/guide/guide.js'
import { PackError, PackLoader } from '../features/packs/loader.js'
import { PackStore } from '../features/packs/store.js'
import { TRUSTED_PACK_KEYS } from '../features/packs/trusted-keys.js'
import { STT_FLAG_HELP, SpeechToText } from '../features/speech/speech-service.js'
import { loadInstalledPack } from './installed-pack.js'
import { modelsOf, type Session } from './session.js'

const USAGE = `Usage:
  ofa guide [--lang en|sw] [--limit N] [--keyword-only] [--json] "question"
                                              guidance cards that answer the question (language guessed unless --lang)
  ofa guide --voice clip.wav --lang en|sw [--limit N] [--json]
                                              the same, asked out loud
  ofa guide --card ID [--lang en|sw] [--json] one card in full
Every command takes --pack ID when more than one pack is installed (ofa pack list).`

export async function guideCommand(config: AppConfig, args: string[], session: Session): Promise<boolean> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      lang: { type: 'string' },
      limit: { type: 'string' },
      voice: { type: 'string' },
      card: { type: 'string' },
      pack: { type: 'string' },
      'keyword-only': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false }
    }
  })
  const query = positionals.join(' ').trim()
  const lang = values.lang
  const limit = values.limit === undefined ? 3 : Number(values.limit)
  const asks = [query, values.voice, values.card].filter(Boolean).length
  if (asks !== 1 || (lang !== undefined && !isLang(lang)) || (values.voice && !lang) || !(Number.isInteger(limit) && limit > 0)) {
    console.error(USAGE)
    return false
  }
  if (values.voice && !(await fs.stat(values.voice).catch(() => undefined))) {
    console.error(`✖ Not found: ${values.voice}`)
    return false
  }
  const action = values.card ? 'card' : values.voice ? 'voice-search' : 'search'
  if (!(await session.require('guide', action))) return false
  if (values.voice && !(await session.require('speech', action))) return false

  const models = await ModelStore.open(config.modelsDir)
  const runtime = new QvacRuntime(models, createSdkPort(), config)
  const embedSpec = MODEL_SPECS.embedder
  const embedding = !values.card && !values['keyword-only'] && models.has(embedSpec.name)
  const embedder = embedding ? qvacEmbedder(runtime, embedSpec) : undefined
  try {
    const loader = new PackLoader({
      trustedKeys: TRUSTED_PACK_KEYS,
      ...(embedder ? { embedding: { embedder, sha256: models.entry(embedSpec.name).sha256 } } : {})
    })
    const pack = await loadInstalledPack(new PackStore(config.packsDir, loader), values.pack)
    const guide = new Guide(pack, {
      ...(embedder ? { embedder } : {}),
      ...(values.voice ? { speech: new SpeechToText(qvacTranscriber(runtime, MODEL_SPECS.stt)) } : {})
    })
    const packRef = `${guide.packId}@${guide.packVersion}`
    const t0 = performance.now()
    const record = (r: GuideResult, extra: { sttMs?: number; heard?: string; flags?: string[] } = {}) =>
      session.activity.record({
        feature: 'guide',
        action,
        outcome: 'ok',
        langs: { from: r.lang },
        timings: { totalMs: performance.now() - t0, ...(extra.sttMs !== undefined ? { sttMs: extra.sttMs } : {}) },
        counts: { hits: r.status === 'match' ? r.hits.length : 0 },
        detail: { status: r.status, mode: r.mode, pack: packRef },
        flags: [...(extra.flags ?? []), ...(r.degraded ? ['keyword-fallback'] : [])],
        ...modelsOf(runtime),
        content: {
          query: r.query,
          ...(extra.heard !== undefined ? { heard: extra.heard } : {}),
          ...(r.status === 'match' ? { cards: r.hits.map((h) => h.card.id).join(',') } : {})
        }
      })

    if (values.card) {
      const card = guide.card(values.card, (lang as Lang | undefined) ?? 'en')
      if (!card) {
        console.error(`✖ No card "${values.card}" in ${guide.packId}; cards: ${guide.list('en').map((c) => c.id).join(', ')}`)
        return false
      }
      await session.activity.record({ feature: 'guide', action, outcome: 'ok', langs: { to: card.lang }, detail: { pack: packRef }, content: { card: card.id } })
      if (values.json) return printJson(card)
      header(guide)
      printCard(card)
      return true
    }

    let result: GuideResult
    if (values.voice) {
      const { transcript, result: r } = await guide.searchByVoice(values.voice, lang as Lang, { limit })
      if (values['keyword-only']) delete r.degraded
      await record(r, { sttMs: transcript.transcribeMs, heard: transcript.text, flags: transcript.flags })
      if (values.json) return printJson({ transcript, result: r })
      console.log(`Heard (${lang}): ${transcript.text || '—'}`)
      for (const f of transcript.flags) console.log(`⚠ ${f}: ${STT_FLAG_HELP[f]}`)
      result = r
    } else {
      result = await guide.search(query, (lang as Lang | undefined) ?? guide.guessLang(query), { limit })
      // Keywords only was asked for: not a degraded search.
      if (values['keyword-only']) delete result.degraded
      await record(result)
      if (values.json) return printJson(result)
    }
    header(guide)
    printResult(result)
    return true
  } catch (err) {
    if (!(err instanceof PackError)) throw err
    console.error(`✖ Pack refused (${err.problem}): ${err.message}`)
    return false
  } finally {
    await runtime.unloadAll()
  }
}

function header(guide: Guide) {
  console.log(`${guide.packId} ${guide.packVersion}${guide.notice ? `  ⚠ ${guide.notice}` : ''}`)
}

function printResult(result: GuideResult) {
  if (result.degraded) console.log(`(keyword search only: ${result.degraded})`)
  if (result.status === 'no-match') {
    console.log(`\n✖ ${result.message}`)
    return
  }
  const [best, ...others] = result.hits
  printCard(best.card, `keyword ${best.confidence.keyword.toFixed(2)}${best.confidence.lift !== undefined ? ` · meaning +${best.confidence.lift.toFixed(2)}` : ''}`)
  if (!others.length) return
  console.log('\nAlso matching:')
  for (const { card } of others) console.log(`  ${card.title}  (ofa guide --card ${card.id}${card.lang === 'sw' ? ' --lang sw' : ''})`)
}

/** Danger signs first, always. */
function printCard(card: GuideCard, scores?: string) {
  console.log(`\n${card.title}  (${card.id} v${card.version}${scores ? `; ${scores}` : ''})`)
  console.log(`\n  ⚠ ${card.lang === 'sw' ? 'DALILI ZA HATARI — mpeleke mara moja ukiona yoyote' : 'DANGER SIGNS — refer at once if any is present'}`)
  for (const sign of card.dangerSigns) console.log(`    • ${sign}`)
  console.log(`\n  ${card.lang === 'sw' ? 'Hatua' : 'Steps'}`)
  for (const [i, step] of card.steps.entries()) console.log(`    ${i + 1}. ${step}`)
  console.log(`\n  ${card.lang === 'sw' ? 'Chanzo' : 'Source'}: ${card.source}`)
}

function printJson(value: unknown): true {
  console.log(JSON.stringify(value, null, 2))
  return true
}
