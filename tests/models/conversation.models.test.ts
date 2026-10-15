/**
 * F4 against the real models (npm run fetch-models first): whole turns, with
 * every model kept loaded. Assertions check key words, not exact strings.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resample, SPEECH_SAMPLE_RATE } from '../../src/core/audio.js'
import { MODEL_CATALOG as M } from '../../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../../src/core/config.js'
import { qvacSpeaker, qvacTranscriber } from '../../src/core/engines.js'
import { ModelStore } from '../../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../../src/core/qvac.js'
import { createConversation, type Conversation } from '../../src/features/conversation/setup.js'
import { SpeechToText } from '../../src/features/speech/speech-service.js'
import { extractQuantities } from '../../src/features/translate/quantities.js'
import { ReadAloud } from '../../src/features/voice/read-aloud.js'

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const needed = [M.stt, M.vad, M.translator, M.embedder, M.ttsT3, M.ttsS3gen]
const installed = needed.every((n) => store.has(n))
const fixture = (name: string) => path.join(PROJECT_ROOT, 'tests/fixtures', name)
const stt = new SpeechToText(qvacTranscriber(runtime))

let dir: string
let conversation: Conversation

beforeAll(async () => {
  if (!installed) return
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-converse-'))
  conversation = await createConversation(runtime, config, { audioDir: dir })
  expect((await conversation.warmUp()).evicted).toEqual([])
}, 180_000)

afterAll(async () => {
  await runtime.unloadAll()
  await shutdown()
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

describe.skipIf(!installed)('ConversationService with real models', { timeout: 120_000 }, () => {
  it('turns English speech into Swahili speech within the 5 s budget', async () => {
    const turn = await conversation.service.turn({ audio: fixture('fleurs-en-1953.wav'), speakerSide: 'clinician' })
    expect(turn.sourceText.toLowerCase()).toMatch(/relocated.*hospital.*cambridge/)
    expect(turn.translation).toMatch(/Hospitali.*Cambridge/)
    expect(turn.flags).toEqual([])
    expect(turn.timings.firstAudioMs).toBeLessThan(5000)
    expect(turn.timings.checkDoneMs).toBeGreaterThanOrEqual(turn.timings.firstAudioMs)
    expect((await fs.stat(turn.audioPath!)).size).toBeGreaterThan(10_000)
  })

  it('speaks the English translation of a patient turn so that Whisper hears it back', async () => {
    const turn = await conversation.service.turn({ audio: fixture('fleurs-sw-1941-quiet.wav'), speakerSide: 'patient' })
    expect(turn.sourceText.toLowerCase()).toMatch(/wanandoa.*mtoto/)
    expect(turn.translation.toLowerCase()).toMatch(/child/)
    const heard = await stt.transcribe(turn.audioPath!, 'en')
    expect(heard.text.toLowerCase()).toMatch(/child/)
  })

  it('carries a spoken Swahili dose through to the English translation', async () => {
    const reader = new ReadAloud(qvacSpeaker(runtime))
    const said = await reader.speak('Mpe mtoto ml 5 mara mbili kwa siku 3.', 'sw')
    const turn = await conversation.service.turn({
      audio: resample(said.samples, said.sampleRate, SPEECH_SAMPLE_RATE),
      speakerSide: 'patient'
    })
    expect(extractQuantities(turn.translation, 'en').map((q) => q.value)).toEqual(expect.arrayContaining(['5', '3']))
    expect(turn.flags).not.toContain('numbers-changed')
  })

  it('keeps all five models loaded across turns', async () => {
    const names = runtime.loaded().map((m) => m.name)
    expect(names.sort()).toEqual([M.embedder, M.ttsT3, M.ttsT3, M.translator, M.stt].sort())
  })
})
