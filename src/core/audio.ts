/**
 * WAV in, 16 kHz mono float32 out: the input every speech model here expects.
 *
 * Pure TypeScript, no ffmpeg. The SDK can decode files inside its worker
 * (@qvac/decoder-audio), but only for file paths; decoding here gives file
 * and in-memory audio one path, and makes it unit-testable without a model.
 */
import fs from 'node:fs/promises'

export const SPEECH_SAMPLE_RATE = 16_000

export interface PcmAudio {
  sampleRate: number
  /** One array per channel, samples in [-1, 1]. */
  channels: Float32Array[]
}

export class WavFormatError extends Error {
  constructor(message: string) {
    super(`Unsupported WAV: ${message}`)
    this.name = 'WavFormatError'
  }
}

const FORMAT_PCM = 1
const FORMAT_FLOAT = 3
const FORMAT_EXTENSIBLE = 0xfffe

/** Decodes integer PCM (8/16/24/32-bit) and float (32/64-bit) WAV, any channel count. */
export function decodeWav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new WavFormatError('not a RIFF/WAVE file')

  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined
  let data: Uint8Array | undefined
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(at)
    let size = view.getUint32(at + 4, true)
    const body = at + 8
    // Streamed WAVs leave the data size at 0 or 0xFFFFFFFF; take the rest of the file.
    if (id === 'data' && (size === 0 || body + size > bytes.length)) size = bytes.length - body
    if (id === 'fmt ') {
      if (size < 16) throw new WavFormatError('fmt chunk too short')
      let format = view.getUint16(body, true)
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the first two bytes of the subformat GUID.
      if (format === FORMAT_EXTENSIBLE && size >= 40) format = view.getUint16(body + 24, true)
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true)
      }
    } else if (id === 'data') {
      data = bytes.subarray(body, body + size)
    }
    at = body + size + (size % 2) // chunks are word-aligned
  }
  if (!fmt) throw new WavFormatError('no fmt chunk')
  if (!data) throw new WavFormatError('no data chunk')
  if (fmt.channels < 1 || fmt.sampleRate < 1) throw new WavFormatError(`${fmt.channels} channels at ${fmt.sampleRate} Hz`)

  const read = sampleReader(fmt.format, fmt.bits)
  const width = fmt.bits / 8
  const frames = Math.floor(data.length / (width * fmt.channels))
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames))
  for (let i = 0, off = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++, off += width) channels[c]![i] = read(dv, off)
  }
  return { sampleRate: fmt.sampleRate, channels }
}

function sampleReader(format: number, bits: number): (dv: DataView, off: number) => number {
  if (format === FORMAT_PCM) {
    switch (bits) {
      case 8:
        return (dv, o) => (dv.getUint8(o) - 128) / 128
      case 16:
        return (dv, o) => dv.getInt16(o, true) / 32768
      case 24:
        return (dv, o) => ((dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) / 8388608)
      case 32:
        return (dv, o) => dv.getInt32(o, true) / 2147483648
    }
  }
  if (format === FORMAT_FLOAT) {
    if (bits === 32) return (dv, o) => dv.getFloat32(o, true)
    if (bits === 64) return (dv, o) => dv.getFloat64(o, true)
  }
  throw new WavFormatError(`format ${format} with ${bits}-bit samples`)
}

/** 16-bit PCM mono WAV, for test fixtures and recordings. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, FORMAT_PCM, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true))
  return bytes
}

export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!
  const out = new Float32Array(channels[0]?.length ?? 0)
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i]! += ch[i]! / channels.length
  return out
}

/** Half-width of the sinc kernel, in input samples at the cutoff rate. */
const SINC_ZEROS = 16

/**
 * Band-limited resampling: windowed sinc (Blackman), cut off at the lower
 * Nyquist so downsampling does not alias. Quality is well past what speech
 * recognition needs; 10 s at 48 kHz takes ~0.3 s on the M4 (35× real time).
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const ratio = to / from
  const scale = Math.min(1, ratio) // cutoff as a fraction of the input Nyquist
  const half = Math.ceil(SINC_ZEROS / scale)
  const out = new Float32Array(Math.round(input.length * ratio))
  for (let i = 0; i < out.length; i++) {
    const t = i / ratio
    const center = Math.floor(t)
    let acc = 0
    let norm = 0
    for (let k = center - half + 1; k <= center + half; k++) {
      if (k < 0 || k >= input.length) continue
      const x = (t - k) * scale
      const w = blackman((t - k) / half)
      const h = w * (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x))
      acc += input[k]! * h
      norm += h
    }
    out[i] = norm ? acc / norm : 0
  }
  return out
}

/** Blackman window over [-1, 1]. */
function blackman(u: number): number {
  if (u <= -1 || u >= 1) return 0
  const a = Math.PI * (u + 1)
  return 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a)
}

/** Decoded WAV → 16 kHz mono. */
export function toSpeechInput(audio: PcmAudio): Float32Array {
  return resample(toMono(audio.channels), audio.sampleRate, SPEECH_SAMPLE_RATE)
}

/**
 * Speech input from a WAV file, or samples that are already 16 kHz mono
 * (what the push-to-talk recorder will deliver).
 */
export async function loadSpeech(input: string | Float32Array): Promise<Float32Array> {
  if (typeof input !== 'string') return input
  return toSpeechInput(decodeWav(await fs.readFile(input)))
}

/**
 * Scales audio so its peak sits at `target`, gaining at most `maxGain`. Quiet
 * recordings (peaks around -55 dBFS) otherwise fall below the Silero VAD and
 * come back as no speech; Whisper itself is level-independent. Near-silence
 * below `floor` is returned unchanged rather than amplified into noise.
 * Returns a new array.
 */
export function normalizePeak(samples: Float32Array, { target = 0.7, maxGain = 1000, floor = 1e-4 } = {}): Float32Array {
  let peak = 0
  for (const v of samples) peak = Math.max(peak, Math.abs(v))
  if (peak < floor) return Float32Array.from(samples)
  const gain = Math.min(maxGain, target / peak)
  return Float32Array.from(samples, (v) => v * gain)
}

export const durationMs = (samples: Float32Array, sampleRate = SPEECH_SAMPLE_RATE) =>
  (samples.length / sampleRate) * 1000

/** Little-endian float32 bytes (the SDK's `f32le`), sharing the samples' memory. */
export function f32leBytes(samples: Float32Array): Uint8Array {
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('Big-endian hosts are not supported')
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
}
