/** Dev-time download helpers shared by the fetch scripts. */
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

/** Slow links drop long downloads; both paths resume, so retrying is cheap. */
export async function withRetries<T>(name: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= attempts) throw err
      console.log(`  ${name}: attempt ${attempt} failed (${(err as Error).message.slice(0, 120)}), retrying in 10 s`)
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }
}

export function progress(total: number) {
  let lastStep = -1
  return (pct: number) => {
    const step = Math.floor(pct / 5)
    if (step !== lastStep) console.log(`  ${Math.round(pct)}% of ${(total / 1e6).toFixed(0)} MB`)
    lastStep = step
  }
}

/** A connection that delivers nothing for this long is dropped, so withRetries can resume it. */
const STALL_MS = 60_000

export async function downloadHttp(url: string, target: string, size: number, stallMs = STALL_MS): Promise<void> {
  const part = `${target}.part`
  const have = (await fs.stat(part).catch(() => null))?.size ?? 0
  const abort = new AbortController()
  const stall = setTimeout(() => abort.abort(new Error(`no data for ${stallMs / 1000} s`)), stallMs)
  const res = await fetch(url, {
    redirect: 'follow',
    signal: abort.signal,
    headers: have > 0 ? { Range: `bytes=${have}-` } : {}
  })
  if (!res.ok || !res.body) {
    clearTimeout(stall)
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`)
  }
  const resuming = res.status === 206
  if (resuming) console.log(`  resuming at ${(have / 1e6).toFixed(0)} MB`)

  const report = progress(size)
  let received = resuming ? have : 0
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      stall.refresh()
      received += chunk.byteLength
      report((received / size) * 100)
      ctrl.enqueue(chunk)
    }
  })
  try {
    await pipeline(
      Readable.fromWeb(res.body.pipeThrough(counter) as NodeReadableStream),
      createWriteStream(part, { flags: resuming ? 'a' : 'w' })
    )
  } finally {
    clearTimeout(stall)
  }
  await fs.rename(part, target)
}
