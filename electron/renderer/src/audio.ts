/**
 * Sound in the window: one player for everything the app says (so two
 * things never talk over each other), the push-to-talk recorder, and the
 * waveforms drawn for both.
 */
import { SPEECH_SAMPLE_RATE, encodeWav, resample } from '../../../src/core/audio.js'
import { h } from './dom.js'

let ctx: AudioContext | null = null
const context = () => (ctx ??= new AudioContext())

export async function decode(wav: Uint8Array): Promise<AudioBuffer> {
  const copy = wav.slice().buffer
  return context().decodeAudioData(copy)
}

type PlayerListener = (playingKey: string | null) => void

/**
 * Plays one thing at a time. `key` names what is playing, so a button can
 * show itself as playing and stop it on a second press. A stream is several
 * WAV pieces played back to back as they arrive.
 */
class Player {
  private sources: AudioBufferSourceNode[] = []
  private endAt = 0
  private streamEnded = true
  key: string | null = null
  private listeners = new Set<PlayerListener>()

  onChange(listener: PlayerListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(key: string | null) {
    this.key = key
    this.listeners.forEach((l) => l(key))
  }

  stop(): void {
    for (const s of this.sources) {
      s.onended = null
      try {
        s.stop()
      } catch {
        // Already stopped.
      }
    }
    this.sources = []
    this.endAt = 0
    this.streamEnded = true
    if (this.key) this.set(null)
  }

  /** Plays a whole recording; resolves when it ends or is stopped. */
  async play(key: string, wav: Uint8Array | AudioBuffer): Promise<void> {
    this.stop()
    this.set(key)
    const buffer = wav instanceof AudioBuffer ? wav : await decode(wav)
    if (this.key !== key) return
    await new Promise<void>((resolve) => {
      const src = this.schedule(buffer)
      src.onended = () => {
        if (this.key === key) this.set(null)
        this.sources = []
        resolve()
      }
    })
  }

  /** Starts a stream of pieces under `key`; pieces then go through `enqueue`. */
  beginStream(key: string): void {
    this.stop()
    this.streamEnded = false
    this.set(key)
  }

  async enqueue(key: string, wav: Uint8Array): Promise<void> {
    if (this.key !== key) return
    const buffer = await decode(wav)
    if (this.key !== key) return
    const src = this.schedule(buffer)
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src)
      if (this.streamEnded && !this.sources.length && this.key === key) this.set(null)
    }
  }

  /** No more pieces will come for this stream. */
  endStream(key: string): void {
    if (this.key !== key) return
    this.streamEnded = true
    if (!this.sources.length) this.set(null)
  }

  private schedule(buffer: AudioBuffer): AudioBufferSourceNode {
    const ac = context()
    void ac.resume()
    const src = ac.createBufferSource()
    src.buffer = buffer
    src.connect(ac.destination)
    const at = Math.max(ac.currentTime + 0.02, this.endAt)
    src.start(at)
    this.endAt = at + buffer.duration
    this.sources.push(src)
    return src
  }

  /** 0–1 through the current recording; for progress bars. */
  get position(): { at: number; end: number } {
    return { at: ctx?.currentTime ?? 0, end: this.endAt }
  }
}

export const player = new Player()

/** Shortest press that counts as speech rather than a stray click. */
export const MIN_RECORDING_MS = 350

export class MicError extends Error {}

/**
 * Push-to-talk. `start` opens the microphone, `stop` closes it and returns
 * 16 kHz mono WAV, which is what the speech model takes. `level` is the
 * loudness of the last few milliseconds, 0–1, for a live waveform.
 */
export class Recorder {
  private stream: MediaStream | null = null
  private ac: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private chunks: Float32Array[] = []
  private startedAt = 0
  private levelBuf = new Float32Array(1024)

  get recording(): boolean {
    return !!this.stream
  }

  async start(): Promise<void> {
    if (this.stream) return
    player.stop()
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch (err) {
      this.stream = null
      const name = err instanceof DOMException ? err.name : ''
      throw new MicError(
        name === 'NotAllowedError'
          ? 'The microphone is off for this app. Turn it on in System Settings › Privacy & Security › Microphone.'
          : name === 'NotFoundError'
            ? 'No microphone found. Connect one and try again.'
            : 'The microphone could not be opened.'
      )
    }
    this.chunks = []
    this.ac = new AudioContext()
    await this.ac.audioWorklet.addModule('recorder-worklet.js')
    const source = this.ac.createMediaStreamSource(this.stream)
    const node = new AudioWorkletNode(this.ac, 'ofa-recorder')
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.chunks.push(e.data)
    this.analyser = this.ac.createAnalyser()
    this.analyser.fftSize = 1024
    source.connect(this.analyser)
    source.connect(node)
    this.startedAt = performance.now()
  }

  get level(): number {
    if (!this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.levelBuf)
    let sum = 0
    for (const v of this.levelBuf) sum += v * v
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 5)
  }

  /** The recording as WAV, or null when the press was too short to hold speech. */
  async stop(): Promise<{ wav: Uint8Array; ms: number } | null> {
    if (!this.stream || !this.ac) return null
    const ms = performance.now() - this.startedAt
    const rate = this.ac.sampleRate
    this.stream.getTracks().forEach((t) => t.stop())
    await this.ac.close()
    this.stream = null
    this.ac = null
    this.analyser = null
    if (ms < MIN_RECORDING_MS) return null
    return { wav: toSpeechWav(this.chunks, rate), ms }
  }

  cancel(): void {
    void this.stop()
  }
}

/** Joins captured blocks and turns them into 16 kHz mono 16-bit WAV. */
export function toSpeechWav(chunks: Float32Array[], sampleRate: number): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const joined = new Float32Array(total)
  let at = 0
  for (const c of chunks) {
    joined.set(c, at)
    at += c.length
  }
  return encodeWav(resample(joined, sampleRate, SPEECH_SAMPLE_RATE), SPEECH_SAMPLE_RATE)
}

/** Peak per bar, 0–1, for drawing a recording as a waveform. */
export function peaks(buffer: AudioBuffer, bars: number): number[] {
  const data = buffer.getChannelData(0)
  const per = Math.max(1, Math.floor(data.length / bars))
  const out: number[] = []
  for (let b = 0; b < bars; b++) {
    let peak = 0
    for (let i = b * per; i < Math.min(data.length, (b + 1) * per); i++) peak = Math.max(peak, Math.abs(data[i]!))
    out.push(peak)
  }
  const max = Math.max(...out, 1e-3)
  return out.map((p) => p / max)
}

/** Draws bars on a canvas; bars before `progress` (0–1) in the accent colour. */
export function drawBars(canvas: HTMLCanvasElement, values: number[], progress = 1, idle = false): void {
  const dpr = devicePixelRatio || 1
  const w = canvas.clientWidth
  const hgt = canvas.clientHeight
  if (!w || !hgt) return
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr)
  if (canvas.height !== Math.round(hgt * dpr)) canvas.height = Math.round(hgt * dpr)
  const g = canvas.getContext('2d')!
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, hgt)
  const css = getComputedStyle(document.documentElement)
  const on = css.getPropertyValue('--accent').trim()
  const off = css.getPropertyValue('--line-strong').trim()
  const n = values.length
  const step = w / n
  const barW = Math.max(1.5, step * 0.55)
  values.forEach((v, i) => {
    const bh = Math.max(2, (idle ? 0.12 : Math.max(0.08, v)) * hgt * 0.9)
    g.fillStyle = i / n < progress ? on : off
    const x = i * step + (step - barW) / 2
    g.beginPath()
    g.roundRect(x, (hgt - bh) / 2, barW, bh, barW / 2)
    g.fill()
  })
}

/** A canvas that shows the live microphone level while recording. */
export function liveWave(recorder: Recorder): { el: HTMLCanvasElement; start(): void; stop(): void } {
  const el = h('canvas', { class: 'wave', 'aria-hidden': 'true' })
  const bars = new Array<number>(48).fill(0)
  let raf = 0
  const frame = () => {
    bars.shift()
    bars.push(recorder.level)
    drawBars(el, bars)
    raf = requestAnimationFrame(frame)
  }
  return {
    el,
    start() {
      bars.fill(0)
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(frame)
    },
    stop() {
      cancelAnimationFrame(raf)
      bars.fill(0)
      drawBars(el, bars, 1, true)
    }
  }
}
