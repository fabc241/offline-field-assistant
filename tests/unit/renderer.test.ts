import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { toSpeechWav } from '../../electron/renderer/src/audio.js'
import { DOC_HELP, FLAG_ADVICE, FLAG_TITLE, speakable } from '../../electron/renderer/src/flags.js'
import { buildRenderer } from '../../scripts/build-electron.js'
import { SPEECH_SAMPLE_RATE, decodeWav } from '../../src/core/audio.js'
import { DOC_FLAGS, DOC_FLAG_HELP } from '../../src/features/documents/document-service.js'
import { STT_FLAGS } from '../../src/features/speech/speech-service.js'
import { FLAGS } from '../../src/features/translate/translation-service.js'
import { TTS_FLAGS } from '../../src/features/voice/read-aloud.js'

describe('push-to-talk recording', () => {
  it('turns captured 48 kHz blocks into 16 kHz mono WAV the speech model takes', () => {
    const rate = 48_000
    const blocks = Array.from({ length: 188 }, (_, b) => Float32Array.from({ length: 128 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * (b * 128 + i)) / rate)))
    const pcm = decodeWav(toSpeechWav(blocks, rate))
    expect(pcm.sampleRate).toBe(SPEECH_SAMPLE_RATE)
    expect(pcm.channels).toHaveLength(1)
    expect(pcm.channels[0]!.length).toBe(Math.round((188 * 128) / 3))
    const peak = Math.max(...pcm.channels[0]!.map(Math.abs))
    expect(peak).toBeGreaterThan(0.45)
    expect(peak).toBeLessThan(0.55)
  })
})

describe('warnings on screen', () => {
  it('has a title and advice for every flag a service can raise', () => {
    for (const flag of [...STT_FLAGS, ...FLAGS, ...TTS_FLAGS, ...DOC_FLAGS]) {
      expect(FLAG_TITLE[flag], flag).toBeTruthy()
      expect(FLAG_ADVICE[flag], flag).toBeTruthy()
    }
  })

  it('gives the document service’s own advice', () => {
    expect(DOC_HELP).toEqual(DOC_FLAG_HELP)
  })

  it('never reads aloud a document part whose translation should not be used', () => {
    expect(speakable({ translation: 'Chukua kidonge 1 mara tatu kwa siku.', flags: [] })).toBe(true)
    // Hard to read on the paper, but the translation itself is usable.
    expect(speakable({ translation: 'Usimpe mtoto chini ya miezi 6.', flags: ['low-confidence'] })).toBe(true)
    expect(speakable({ translation: 'Mafuta ya kuzuia ugonjwa wa ugonjwa wa ugonjwa wa', flags: ['translation-loop'] })).toBe(false)
    expect(speakable({ translation: 'Chukua vidonge 3', flags: ['numbers-changed'] })).toBe(false)
    expect(speakable({ translation: '15/10/2026', flags: [], kept: 'no-words' })).toBe(false)
    expect(speakable({ translation: '  ', flags: [] })).toBe(false)
  })
})

describe('the page bundle', () => {
  it('builds for the browser with no Node module left in it, and loads only its own files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-renderer-'))
    try {
      await buildRenderer(dir)
      const files = await fs.readdir(dir)
      expect(files).toEqual(expect.arrayContaining(['index.html', 'app.js', 'styles.css', 'theme.js', 'recorder-worklet.js']))
      const js = await fs.readFile(path.join(dir, 'app.js'), 'utf8')
      expect(js).not.toMatch(/\brequire\(|from ["']node:|import\(["']node:/)

      const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8')
      const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html.replace(/\s+/g, ' '))?.[1] ?? ''
      expect(csp).toMatch(/default-src 'none'/)
      expect(csp).toMatch(/script-src 'self'/)
      expect(csp).not.toMatch(/unsafe|connect-src|https?:/)
      // Every script and stylesheet the page names is in the build.
      for (const [, ref] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) expect(files, ref).toContain(ref)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
