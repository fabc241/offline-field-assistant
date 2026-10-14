/**
 * F3 against the real Chatterbox and Whisper models (npm run fetch-models
 * first). Speech is checked by ear-proxy: what Whisper hears back.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { encodeWav, resample, SPEECH_SAMPLE_RATE } from '../../src/core/audio.js'
import { MODEL_CATALOG as M, ttsSpec } from '../../src/core/catalog.js'
import { loadConfig } from '../../src/core/config.js'
import { qvacSpeaker, qvacTranscriber, type Lang } from '../../src/core/engines.js'
import { ModelStore } from '../../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../../src/core/qvac.js'
import { SpeechToText } from '../../src/features/speech/speech-service.js'
import { extractQuantities } from '../../src/features/translate/quantities.js'
import { ReadAloud, type Speech } from '../../src/features/voice/read-aloud.js'
import { consentFile, speakerSpecs } from '../../src/features/voice/voices.js'

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const reader = new ReadAloud(qvacSpeaker(runtime))
const stt = new SpeechToText(qvacTranscriber(runtime))
const installed = [M.ttsT3, M.ttsS3gen, M.stt, M.vad].every((n) => store.has(n))

const heard = async (speech: Speech) =>
  (await stt.transcribe(resample(speech.samples, speech.sampleRate, SPEECH_SAMPLE_RATE), speech.lang)).text
const values = (text: string, lang: Lang) => extractQuantities(text, lang).map((q) => q.value)
/** Whisper joins and splits Swahili words freely ("mililitatano marambili"), so compare letters only. */
const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}]/gu, '')

afterAll(async () => {
  await runtime.unloadAll()
  await shutdown()
})

describe.skipIf(!installed)('ReadAloud with real Chatterbox', { timeout: 180_000 }, () => {
  it('speaks a Swahili dose that Whisper hears back with the same numbers', async () => {
    const speech = await reader.speak('Mpe mtoto ml 5 mara mbili kwa siku 3.', 'sw')
    expect(speech.flags).toEqual([])
    const back = squash(await heard(speech))
    for (const dose of ['mililita tano', 'mara mbili', 'siku tatu']) expect(back).toContain(squash(dose))
  })

  it('speaks an English dose that Whisper hears back with the same numbers', async () => {
    const speech = await reader.speak('Take 500 mg every 8 hours.', 'en')
    expect(speech.flags).toEqual([])
    expect(values(await heard(speech), 'en')).toEqual(expect.arrayContaining(['500', '8']))
  })

  it('runs faster than real time on Metal once warm, and starts the audio before the text is done', async () => {
    const speech = await reader.speak('Kunywa maji mengi safi. Rudi baada ya wiki moja. Endelea kumnyonyesha mtoto.', 'sw')
    expect(speech.parts).toHaveLength(3)
    expect(speech.realTimeFactor).toBeLessThan(1)
    expect(speech.firstAudioMs).toBeLessThan(speech.synthMs / 2)
  })

  it('needs no reload between syntheses: the same sentence gives the same audio every time', async () => {
    // Known Chatterbox failure: state left in the KV cache distorts or repeats
    // later audio. Seeded synthesis is deterministic, so any leak shows as a difference.
    const a = 'Mtoto ana homa tangu jana usiku.'
    const b = 'Nitakuuliza maswali kadhaa kuhusu afya yako, kisha nitapima joto lako.'
    const runs: Float32Array[] = []
    for (const text of [a, b, a, b, a]) {
      const s = await reader.speak(text, 'sw')
      if (text === a) runs.push(s.samples)
    }
    expect(runs[1]).toEqual(runs[0])
    expect(runs[2]).toEqual(runs[0])
  })

  it('keeps one instance per language loaded side by side', async () => {
    await reader.speak('Hello.', 'en')
    await reader.speak('Habari.', 'sw')
    expect(runtime.loaded().filter((m) => m.name === M.ttsT3)).toHaveLength(2)
  })

  it('streams a sentence in several chunks when loaded with chunk streaming', async () => {
    const streaming = new ReadAloud(qvacSpeaker(runtime, (lang) => ttsSpec(lang, { chunkTokens: 25 })))
    let chunks = 0
    const speech = await streaming.speak('Nitakuuliza maswali kadhaa kuhusu afya yako.', 'sw', { onAudio: () => chunks++ })
    expect(chunks).toBeGreaterThan(1)
    expect((await heard(speech)).toLowerCase()).toMatch(/maswali/)
    await runtime.unloadAll()
  })

  it('speaks with a consented reference voice', async () => {
    // The reference is Chatterbox's own built-in voice, rendered here: no real person is cloned in tests.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-voice-'))
    const ref = await reader.speak(
      'Habari za asubuhi. Jina langu ni muuguzi wa kliniki hii. Nitakuuliza maswali kadhaa kuhusu afya yako na ya familia yako.',
      'sw'
    )
    const wav = path.join(dir, 'synthetic-sw.wav')
    await fs.writeFile(wav, encodeWav(ref.samples, ref.sampleRate))
    await fs.writeFile(
      consentFile(wav),
      JSON.stringify({ speaker: 'Chatterbox built-in voice (synthetic)', consentDate: '2026-10-14', scope: 'model test' })
    )
    const cloned = new ReadAloud(qvacSpeaker(runtime, await speakerSpecs({ sw: wav })))
    const text = 'Kunywa maji mengi safi.'
    const speech = await cloned.speak(text, 'sw')
    const plain = await reader.speak(text, 'sw')
    expect(speech.samples).not.toEqual(plain.samples)
    expect((await heard(speech)).toLowerCase()).toMatch(/maji/)
    await fs.rm(dir, { recursive: true })
  })
})
