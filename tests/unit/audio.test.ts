import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SPEECH_SAMPLE_RATE,
  WavFormatError,
  decodeWav,
  encodeWav,
  f32leBytes,
  loadSpeech,
  normalizePeak,
  resample,
  toMono
} from '../../src/core/audio.js'

const tone = (hz: number, rate: number, seconds: number, amp = 0.5) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate))

const rms = (x: Float32Array, skip = 0) => {
  const part = x.subarray(skip, x.length - skip)
  return Math.sqrt(part.reduce((s, v) => s + v * v, 0) / part.length)
}

/** Builds a WAV with an arbitrary format, for the decoder paths encodeWav does not produce. */
function wav(opts: { format: number; bits: number; channels: number; rate: number; frames: number[][]; extensible?: boolean; extraChunk?: boolean }) {
  const { format, bits, channels, rate, frames } = opts
  const width = bits / 8
  const dataSize = frames.length * channels * width
  const fmtSize = opts.extensible ? 40 : 16
  const extra = opts.extraChunk ? 8 + 3 + 1 : 0 // odd-sized LIST chunk + pad byte
  const buf = Buffer.alloc(12 + 8 + fmtSize + extra + 8 + dataSize)
  let o = 0
  buf.write('RIFF', o), (o += 4)
  buf.writeUInt32LE(buf.length - 8, o), (o += 4)
  buf.write('WAVE', o), (o += 4)
  buf.write('fmt ', o), (o += 4)
  buf.writeUInt32LE(fmtSize, o), (o += 4)
  buf.writeUInt16LE(opts.extensible ? 0xfffe : format, o)
  buf.writeUInt16LE(channels, o + 2)
  buf.writeUInt32LE(rate, o + 4)
  buf.writeUInt32LE(rate * channels * width, o + 8)
  buf.writeUInt16LE(channels * width, o + 12)
  buf.writeUInt16LE(bits, o + 14)
  if (opts.extensible) buf.writeUInt16LE(format, o + 24)
  o += fmtSize
  if (opts.extraChunk) {
    buf.write('LIST', o), (o += 4)
    buf.writeUInt32LE(3, o), (o += 4)
    o += 4 // 3 bytes + pad
  }
  buf.write('data', o), (o += 4)
  buf.writeUInt32LE(dataSize, o), (o += 4)
  for (const frame of frames) {
    for (const v of frame) {
      if (format === 3 && bits === 32) buf.writeFloatLE(v, o)
      else if (format === 3) buf.writeDoubleLE(v, o)
      else if (bits === 8) buf.writeUInt8(Math.round(v * 127) + 128, o)
      else if (bits === 16) buf.writeInt16LE(Math.round(v * 32767), o)
      else if (bits === 24) buf.writeIntLE(Math.round(v * 8388607), o, 3)
      else buf.writeInt32LE(Math.round(v * 2147483647), o)
      o += width
    }
  }
  return new Uint8Array(buf)
}

describe('decodeWav', () => {
  it('round-trips 16-bit PCM written by encodeWav', () => {
    const x = tone(440, 16_000, 0.1)
    const out = decodeWav(encodeWav(x, 16_000))
    expect(out.sampleRate).toBe(16_000)
    expect(out.channels).toHaveLength(1)
    expect(out.channels[0]!.length).toBe(x.length)
    expect(Math.max(...out.channels[0]!.map((v, i) => Math.abs(v - x[i]!)))).toBeLessThan(1e-4)
  })

  it.each([
    [1, 8],
    [1, 24],
    [1, 32],
    [3, 32],
    [3, 64]
  ])('decodes format %i with %i-bit samples', (format, bits) => {
    const out = decodeWav(wav({ format, bits, channels: 1, rate: 8000, frames: [[0.5], [-0.25], [0]] }))
    const digits = bits === 8 ? 2 : 6
    const [a, b, c] = out.channels[0]!
    expect(a).toBeCloseTo(0.5, digits)
    expect(b).toBeCloseTo(-0.25, digits)
    expect(c).toBeCloseTo(0, digits)
  })

  it('splits interleaved channels, reads WAVE_FORMAT_EXTENSIBLE and skips odd-sized chunks', () => {
    const out = decodeWav(
      wav({ format: 1, bits: 16, channels: 2, rate: 48_000, frames: [[0.5, -0.5], [0.25, 0]], extensible: true, extraChunk: true })
    )
    expect(out.sampleRate).toBe(48_000)
    expect([...out.channels[0]!].map((v) => +v.toFixed(3))).toEqual([0.5, 0.25])
    expect([...out.channels[1]!].map((v) => +v.toFixed(3))).toEqual([-0.5, 0])
  })

  it('reads a streamed WAV whose data size was never filled in', () => {
    const bytes = encodeWav(Float32Array.of(0.5, 0.5, 0.5), 16_000)
    new DataView(bytes.buffer).setUint32(40, 0xffffffff, true)
    expect(decodeWav(bytes).channels[0]).toHaveLength(3)
  })

  it('rejects non-WAV input and unsupported encodings', () => {
    expect(() => decodeWav(new TextEncoder().encode('ID3 not a wav file'))).toThrow(WavFormatError)
    expect(() => decodeWav(wav({ format: 6, bits: 8, channels: 1, rate: 8000, frames: [[0]] }))).toThrow(/format 6/)
  })
})

describe('resample', () => {
  it('keeps a speech-band tone at the same level and frequency', () => {
    const out = resample(tone(1000, 48_000, 0.5), 48_000, 16_000)
    expect(out.length).toBe(8000)
    expect(rms(out, 200)).toBeCloseTo(0.5 / Math.SQRT2, 2)
    // zero crossings: 1000 Hz → 2 per ms
    let crossings = 0
    for (let i = 201; i < out.length - 200; i++) if (Math.sign(out[i]!) !== Math.sign(out[i - 1]!)) crossings++
    expect(crossings / ((out.length - 401) / 16)).toBeCloseTo(2, 1)
  })

  it('removes content above the new Nyquist instead of aliasing it', () => {
    const out = resample(tone(12_000, 48_000, 0.5), 48_000, 16_000)
    expect(rms(out, 200)).toBeLessThan(0.01)
  })

  it('upsamples 8 kHz telephone audio', () => {
    const out = resample(tone(500, 8000, 0.5), 8000, 16_000)
    expect(out.length).toBe(8000)
    expect(rms(out, 200)).toBeCloseTo(0.5 / Math.SQRT2, 2)
  })
})

describe('normalizePeak', () => {
  it('raises a quiet recording to the target peak without touching the input', () => {
    const quiet = Float32Array.of(0.002, -0.001, 0)
    const out = normalizePeak(quiet)
    expect(out[0]).toBeCloseTo(0.7)
    expect(out[1]).toBeCloseTo(-0.35)
    expect(quiet[0]).toBe(Math.fround(0.002))
  })

  it('also lowers clipping-level input, caps the gain and leaves near-silence alone', () => {
    expect(normalizePeak(Float32Array.of(1, -0.5))[0]).toBeCloseTo(0.7)
    expect(normalizePeak(Float32Array.of(0.0002), { maxGain: 100 })[0]).toBeCloseTo(0.02)
    expect([...normalizePeak(Float32Array.of(0.00005, 0))]).toEqual([0.00005, 0].map(Math.fround))
  })
})

describe('speech input', () => {
  it('averages channels to mono', () => {
    expect([...toMono([Float32Array.of(1, 0), Float32Array.of(0, 0.5)])]).toEqual([0.5, 0.25])
  })

  it('loads a 44.1 kHz stereo WAV file as 16 kHz mono', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-audio-'))
    const file = path.join(dir, 'clip.wav')
    const left = tone(440, 44_100, 1)
    await fs.writeFile(file, wav({ format: 1, bits: 16, channels: 2, rate: 44_100, frames: [...left].map((v) => [v, v]) }))
    const samples = await loadSpeech(file)
    expect(samples.length).toBe(SPEECH_SAMPLE_RATE)
    expect(rms(samples, 200)).toBeCloseTo(0.5 / Math.SQRT2, 2)
    await fs.rm(dir, { recursive: true })
  })

  it('passes samples through and exposes them as f32le bytes without copying', async () => {
    const x = Float32Array.of(0.25, -1)
    expect(await loadSpeech(x)).toBe(x)
    const bytes = f32leBytes(x)
    expect(bytes.buffer).toBe(x.buffer)
    expect(new DataView(bytes.buffer).getFloat32(4, true)).toBe(-1)
  })
})
