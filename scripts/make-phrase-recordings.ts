/**
 * Dev only: placeholder recordings for a pack source's phrases, made with
 * Chatterbox's built-in voice (never a cloned one), each marked synthetic.
 * Native-speaker recordings replace them later: drop the WAV in, delete its
 * .synthetic.json, and the pack stops tagging it.
 *
 *   npm run make-phrase-recordings [-- --force] [content/sample]
 *
 * Only phrases without a current recording are rendered; human recordings
 * are never touched. Whisper hears each take back; a take it does not hear
 * well enough is rendered again with other seeds, and the best take is kept.
 * Seeds and Whisper are deterministic, so a phrase always comes out the same.
 */
import path from 'node:path'
import { parseArgs } from 'node:util'
import { SPEECH_SAMPLE_RATE, resample } from '../src/core/audio.js'
import { MODEL_CATALOG, ttsSpec } from '../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { qvacSpeaker, qvacTranscriber } from '../src/core/engines.js'
import { ModelStore } from '../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../src/core/qvac.js'
import { makePlaceholderRecordings } from '../src/features/phrasebook/placeholders.js'
import { SpeechToText } from '../src/features/speech/speech-service.js'
import { ReadAloud } from '../src/features/voice/read-aloud.js'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { force: { type: 'boolean', default: false } } })
const dir = path.resolve(positionals[0] ?? path.join(PROJECT_ROOT, 'content/sample'))

const config = loadConfig()
const runtime = new QvacRuntime(await ModelStore.open(config.modelsDir), createSdkPort(), config)
const stt = new SpeechToText(qvacTranscriber(runtime))
try {
  const report = await makePlaceholderRecordings(dir, {
    engine: MODEL_CATALOG.ttsT3,
    readerFor: (seed) => new ReadAloud(qvacSpeaker(runtime, (lang) => ttsSpec(lang, { seed }))),
    listen: async (speech) => (await stt.transcribe(resample(speech.samples, speech.sampleRate, SPEECH_SAMPLE_RATE), speech.lang)).text,
    force: values.force,
    onRecording: (r) =>
      console.log(
        `${r.ref.padEnd(40)} ${(r.audioMs / 1000).toFixed(1).padStart(4)} s  CER ${String(r.cer).padStart(4)}` +
          (r.takes > 1 ? `  (${r.takes} takes, seed ${r.seed ?? 'default'})` : '') +
          `  heard "${r.heard}"` +
          (r.flags.length ? `  ⚠ ${r.flags.join(', ')}` : '')
      )
  })
  console.log(`\n${report.made.length} made, ${report.current} already current, ${report.human} human recordings left as they are`)
  for (const m of report.missing) console.log(`⚠ ${m.id} (${m.lang}) refers to ${m.ref}, which does not exist`)
  if (report.made.length) console.log(`phrases.csv in ${path.relative(PROJECT_ROOT, dir) || '.'} now points at them.`)
} finally {
  await runtime.unloadAll()
  await shutdown()
}
