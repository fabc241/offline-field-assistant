/**
 * Plays audio as it arrives, through macOS afplay. Whatever is queued while
 * one batch plays is joined into the next file, so a sentence and the pause
 * after it start one afplay rather than two. The app's UI will play through
 * Web Audio instead; this is for the CLI.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { encodeWav } from '../core/audio.js'
import type { SpeechAudio } from '../core/engines.js'

export class AfplayQueue {
  private pending: Float32Array[] = []
  private sampleRate = 0
  private playing: Promise<void> | undefined
  private failure: Error | undefined
  private dir: Promise<string> | undefined
  private n = 0

  constructor() {
    if (process.platform !== 'darwin') throw new Error('--play needs macOS (afplay); use --out and another player')
  }

  enqueue({ samples, sampleRate }: SpeechAudio): void {
    if (this.failure) return
    this.sampleRate = sampleRate
    this.pending.push(samples)
    this.playing ??= this.run()
  }

  /** Resolves when everything queued so far has played. */
  async drain(): Promise<void> {
    while (this.playing) await this.playing
    if (this.dir) await fs.rm(await this.dir, { recursive: true, force: true })
    this.dir = undefined
    if (this.failure) throw this.failure
  }

  private async run(): Promise<void> {
    try {
      this.dir ??= fs.mkdtemp(path.join(os.tmpdir(), 'ofa-play-'))
      const dir = await this.dir
      while (this.pending.length) {
        const batch = this.pending.splice(0)
        const joined = new Float32Array(batch.reduce((s, b) => s + b.length, 0))
        batch.reduce((at, b) => (joined.set(b, at), at + b.length), 0)
        const file = path.join(dir, `${this.n++}.wav`)
        await fs.writeFile(file, encodeWav(joined, this.sampleRate))
        await afplay(file)
        await fs.rm(file, { force: true })
      }
    } catch (err) {
      this.failure = err as Error
      this.pending = []
    } finally {
      // Same tick as the last empty-queue check, so nothing enqueued in between is stranded.
      this.playing = undefined
    }
  }
}

function afplay(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('afplay', [file], { stdio: 'ignore' })
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`afplay exited with code ${code}`))))
  })
}
