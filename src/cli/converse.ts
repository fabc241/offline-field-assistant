import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { PROJECT_ROOT, type AppConfig } from '../core/config.js'
import { ModelStore } from '../core/model-store.js'
import { QvacRuntime, createSdkPort } from '../core/qvac.js'
import { TURN_FLAG_HELP, isSide, type Turn, type TurnEvent } from '../features/conversation/conversation-service.js'
import { createConversation } from '../features/conversation/setup.js'
import { AfplayQueue } from './player.js'
import { modelsOf, type Session } from './session.js'

const USAGE = 'Usage: ofa converse --side clinician|patient [--play] [--out-dir DIR] [--json] turn.wav [more.wav …]'

export async function converseCommand(config: AppConfig, args: string[], session: Session): Promise<boolean> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      side: { type: 'string' },
      play: { type: 'boolean', default: false },
      'out-dir': { type: 'string' },
      json: { type: 'boolean', default: false }
    }
  })
  const { side } = values
  if (!side || !isSide(side) || positionals.length === 0) {
    console.error(USAGE)
    return false
  }
  const missing = await Promise.all(positionals.map((f) => fs.access(f).then(() => null, () => f)))
  if (missing.some(Boolean)) {
    console.error(`✖ Not found: ${missing.filter(Boolean).join(', ')}`)
    return false
  }
  if (!(await session.require('conversation', 'turn'))) return false

  const runtime = new QvacRuntime(await ModelStore.open(config.modelsDir), createSdkPort(), config)
  const audioDir = path.resolve(values['out-dir'] ?? path.join(PROJECT_ROOT, 'var/conversation'))
  const { service, warmUp } = await createConversation(runtime, config, { audioDir })
  const player = values.play ? new AfplayQueue() : undefined
  const log = (line: string) => values.json || console.log(line)
  try {
    const warm = await warmUp()
    if (!values.json) console.error(`Models loaded and warmed up in ${s(warm.warmUpMs)}`)
    if (warm.evicted.length) {
      console.error(`⚠ Not all models fit the memory budget (${warm.evicted.join(', ')} unloaded): turns will reload them.`)
    }

    const from = service.languageOf(side)
    for (const file of positionals) {
      log(`\n${file}`)
      let speaking = false
      const turn = await service.turn({
        audio: file,
        speakerSide: side,
        onEvent: (e) => {
          if (e.type === 'audio') {
            player?.enqueue(e.chunk)
            if (speaking) return
            speaking = true
          }
          log(describe(e))
        }
      })
      const { firstAudioMs, sttMs, translateMs, speechDoneMs, checkDoneMs, totalMs, utteranceMs } = turn.timings
      await session.activity.record({
        feature: 'conversation',
        action: 'turn',
        outcome: 'ok',
        langs: { from: turn.sourceLang, to: turn.targetLang },
        timings: { utteranceMs, sttMs, translateMs, firstAudioMs, speechDoneMs, checkDoneMs, totalMs },
        detail: { side: turn.speakerSide },
        flags: turn.flags,
        ...modelsOf(runtime),
        content: { transcript: turn.sourceText, translation: turn.translation, backTranslation: turn.backTranslation }
      })
      if (values.json) {
        console.log(JSON.stringify({ file, ...turn }, null, 2))
        continue
      }
      printSummary(turn, from)
      await player?.drain()
    }
    await player?.drain()
    return true
  } finally {
    await runtime.unloadAll()
  }
}

const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`

function describe(e: TurnEvent): string {
  const at = s(e.atMs).padStart(6)
  switch (e.type) {
    case 'transcript':
      return `${at}  heard        ${e.transcript.text || '—'}  (${s(e.transcript.audioMs)} of speech)`
    case 'translation':
      return `${at}  translated   ${e.translation.translation}`
    case 'audio':
      return `${at}  speaking`
    case 'check': {
      const n = e.check.numericCheck
      return `${at}  checked      ↩ ${e.check.backTranslation}  (fidelity ${e.check.fidelity.toFixed(2)}, numbers ${n.ok ? '✓' : '✗'})`
    }
  }
}

function printSummary(turn: Turn, from: string) {
  const t = turn.timings
  console.log(`\n${turn.speakerSide} (${from} → ${turn.targetLang})`)
  if (turn.speech) {
    console.log(
      `  first audio after ${s(t.firstAudioMs)} (speech-to-text ${s(t.sttMs)}, translation ${s(t.translateMs)}); ` +
        `${s(turn.speech.audioMs)} of audio, all synthesized at ${s(t.speechDoneMs)}; check at ${s(t.checkDoneMs)}`
    )
  }
  if (turn.audioPath) console.log(`→ ${turn.audioPath}`)
  for (const f of turn.flags) console.log(`⚠ ${f}: ${TURN_FLAG_HELP[f]}`)
}
