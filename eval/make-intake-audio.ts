/**
 * Renders every second intake sentence (30) in Swahili and English with
 * Chatterbox, into var/eval-audio/intake-tts-<lang>/, as clinic-vocabulary
 * clips for the speech-to-text eval.
 *
 *   npm run eval:make-intake-audio
 *
 * Synthetic speech is a stand-in until real recordings of the placeholder
 * phrases exist: it is cleaner than a clinic and carries Chatterbox's own
 * pronunciation errors, so its WER is not a field number. The text is sent as
 * written (`raw`), as when F2 was measured; F3's eval covers the spoken form.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { resample, encodeWav, SPEECH_SAMPLE_RATE } from '../src/core/audio.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { LANGS, qvacSpeaker } from '../src/core/engines.js'
import { ModelStore } from '../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../src/core/qvac.js'
import { ReadAloud } from '../src/features/voice/read-aloud.js'
import { EVAL_AUDIO_DIR, writeSet, type Clip } from './audio-sets.js'
import { parseCsv } from '../src/core/csv.js'

const rows = parseCsv(await fs.readFile(path.join(PROJECT_ROOT, 'eval/datasets/intake.csv'), 'utf8')).filter(
  (_, i) => i % 2 === 0
)
const config = loadConfig()
const runtime = new QvacRuntime(await ModelStore.open(config.modelsDir), createSdkPort(), config)
const reader = new ReadAloud(qvacSpeaker(runtime))

for (const lang of LANGS) {
  const set = `intake-tts-${lang}`
  const dir = path.join(EVAL_AUDIO_DIR, set)
  await fs.mkdir(dir, { recursive: true })
  const clips: Clip[] = []
  let audioS = 0
  const t0 = performance.now()
  for (const row of rows) {
    const text = row[lang]!
    const { samples, sampleRate } = await reader.speak(text, lang, { raw: true })
    const speech = resample(samples, sampleRate, SPEECH_SAMPLE_RATE)
    audioS += speech.length / SPEECH_SAMPLE_RATE
    const file = path.join(dir, `${row.id}.wav`)
    await fs.writeFile(file, encodeWav(speech, SPEECH_SAMPLE_RATE))
    clips.push({ id: `${lang}-${row.id}`, lang, file, text })
  }
  await writeSet(set, clips)
  await runtime.unloadAll()
  console.log(`✓ ${set}: ${clips.length} clips, ${audioS.toFixed(0)} s of audio in ${((performance.now() - t0) / 1000).toFixed(0)} s`)
}
await shutdown()
