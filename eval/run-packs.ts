/**
 * F5 eval: builds, signs and loads a content pack with the real embedding
 * model, and measures what a device would see.
 *
 *   npm run eval:packs [-- --dir content/sample --flip-sample N --audio-stride N]
 *
 * - Build: source validation, card vectors (EmbeddingGemma), archive; pack size.
 * - Load: verify and load time of the signed pack (median of 50).
 * - Tamper sweep: flip the lowest bit of every byte of the signed pack in turn
 *   (or of N random bytes with --flip-sample) and count how many the loader
 *   accepts. The target is zero. Recordings are megabytes of sample data
 *   behind one sha256 each, so inside them only the first 64 bytes (the WAV
 *   header) and every Nth byte after are flipped (--audio-stride, default 499). The archive's CRCs catch these first, so a
 *   second sweep flips every byte of every file and rewrites the archive with
 *   correct CRCs, as a deliberate attacker would: only the signature and the
 *   manifest's sha256 stand in the way.
 * - Recompute: a device whose embedding model differs recomputes the vectors;
 *   with the same model they must match the packed ones.
 * - Cross-language alignment: for each card, is its Swahili vector closest to
 *   its own English vector among all cards? A first look at whether card
 *   vectors can serve both languages in the guide search (F7).
 *
 * The signing key is generated for the run; the dev key is not needed.
 * Writes eval/outputs/packs-summary.json.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { MODEL_SPECS } from '../src/core/catalog.js'
import { PROJECT_ROOT, loadConfig } from '../src/core/config.js'
import { qvacEmbedder } from '../src/core/engines.js'
import { ModelStore } from '../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../src/core/qvac.js'
import { buildPack, signPack } from '../src/features/packs/build.js'
import { PackError, PackLoader, parseArchive, type PackProblem } from '../src/features/packs/loader.js'
import { writeArchive } from '../src/features/packs/archive.js'
import { generateSigningKey, loadPrivateKey, trustedKey } from '../src/features/packs/signing.js'
import { cosine } from '../src/features/translate/checks.js'
import { quantile, round } from './stats.js'

const { values } = parseArgs({ options: { dir: { type: 'string' }, 'flip-sample': { type: 'string' }, 'audio-stride': { type: 'string' } } })
const audioStride = Number(values['audio-stride'] ?? 499)
/** Byte offsets to flip in `data`: all of it, or for a recording its header and every audioStride-th byte. */
const offsetsIn = (name: string, length: number) =>
  Array.from({ length }, (_, i) => i).filter((i) => !name.startsWith('audio/') || i < 64 || i % audioStride === 0)
const sourceDir = path.resolve(values.dir ?? path.join(PROJECT_ROOT, 'content/sample'))
const outDir = path.join(PROJECT_ROOT, 'eval/outputs')
await fs.mkdir(outDir, { recursive: true })

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const spec = MODEL_SPECS.embedder
const embedder = qvacEmbedder(runtime, spec)
const model = { name: spec.name, sha256: store.entry(spec.name).sha256 }

const key = generateSigningKey()
const trustedKeys = [trustedKey('eval key', key.publicKeyPem)]

// Build twice: the first includes loading EmbeddingGemma.
const builds: { totalMs: number; embedMs: number }[] = []
let built!: Awaited<ReturnType<typeof buildPack>>
for (let i = 0; i < 2; i++) {
  const t0 = performance.now()
  built = await buildPack(sourceDir, { embedder, embeddingModel: model })
  builds.push({ totalMs: performance.now() - t0, embedMs: built.embedMs })
}
const t0 = performance.now()
const signed = signPack(built.bytes, loadPrivateKey(key.privateKeyPem)).bytes
const signMs = performance.now() - t0

const loader = new PackLoader({ trustedKeys, embedding: { embedder, sha256: model.sha256 } })
const loadMs: number[] = []
let loaded!: Awaited<ReturnType<PackLoader['verifyAndLoad']>>
for (let i = 0; i < 50; i++) {
  const t = performance.now()
  loaded = await loader.verifyAndLoad(signed)
  loadMs.push(performance.now() - t)
}

// Tamper sweep. Stored entries sit in the archive in order: a 30-byte local header, the name, the data.
const flipSample = values['flip-sample'] ? Number(values['flip-sample']) : undefined
const audioSpans: [start: number, end: number][] = []
let at = 0
for (const [name, data] of parseArchive(signed)) {
  const start = at + 30 + Buffer.byteLength(name)
  if (name.startsWith('audio/')) audioSpans.push([start, start + data.length])
  at = start + data.length
}
const inAudio = (i: number) => audioSpans.find(([s, e]) => i >= s && i < e)
const positions = flipSample
  ? Array.from({ length: flipSample }, (_, i) => Math.floor(((i * 2654435761) % 2 ** 32) / 2 ** 32 * signed.length))
  : Array.from({ length: signed.length }, (_, i) => i).filter((i) => {
      const span = inAudio(i)
      return !span || i - span[0] < 64 || (i - span[0]) % audioStride === 0
    })
const sweepLoader = new PackLoader({ trustedKeys })
const byProblem: Partial<Record<PackProblem, number>> = {}
const accepted: number[] = []
const tSweep = performance.now()
for (const i of positions) {
  const bad = Buffer.from(signed)
  bad[i]! ^= 0x01
  try {
    await sweepLoader.verifyAndLoad(bad)
    accepted.push(i)
  } catch (err) {
    if (!(err instanceof PackError)) throw err
    byProblem[err.problem] = (byProblem[err.problem] ?? 0) + 1
  }
}
const sweepMs = performance.now() - tSweep

// Same, with the CRCs repaired after each flip.
const entries = [...parseArchive(signed)].map(([name, data]) => ({ name, data }))
const repaired: { flipped: number; accepted: string[]; byProblem: Partial<Record<PackProblem, number>>; byFile: Record<string, number> } = {
  flipped: 0,
  accepted: [],
  byProblem: {},
  byFile: {}
}
const tRepaired = performance.now()
for (const [e, entry] of entries.entries()) {
  const filePositions = flipSample
    ? positions.map((p) => p % Math.max(1, entry.data.length)).slice(0, entry.data.length)
    : offsetsIn(entry.name, entry.data.length)
  repaired.byFile[entry.name] = filePositions.length
  for (const i of filePositions) {
    const data = Buffer.from(entry.data)
    data[i]! ^= 0x01
    const bad = writeArchive(entries.map((x, j) => (j === e ? { name: x.name, data } : x)))
    repaired.flipped++
    try {
      await sweepLoader.verifyAndLoad(bad)
      repaired.accepted.push(`${entry.name}@${i}`)
    } catch (err) {
      if (!(err instanceof PackError)) throw err
      repaired.byProblem[err.problem] = (repaired.byProblem[err.problem] ?? 0) + 1
    }
  }
}
const repairedMs = performance.now() - tRepaired

// Recompute on a "device" whose model hash differs from the pack's.
const device = new PackLoader({ trustedKeys, embedding: { embedder, sha256: 'f'.repeat(64) } })
const tRe = performance.now()
const recomputed = await device.verifyAndLoad(signed)
const recomputeMs = performance.now() - tRe
let minCos = 1
let maxAbs = 0
for (const [id, v] of loaded.vectors!) {
  for (const lang of ['en', 'sw'] as const) {
    const a = [...v[lang]]
    const b = [...recomputed.vectors!.get(id)![lang]]
    minCos = Math.min(minCos, cosine(a, b))
    maxAbs = Math.max(maxAbs, ...a.map((x, i) => Math.abs(x - b[i]!)))
  }
}

// Cross-language alignment.
const ids = [...loaded.vectors!.keys()]
const alignment = ids.map((id) => {
  const sw = [...loaded.vectors!.get(id)!.sw]
  const ranked = ids
    .map((other) => ({ other, sim: cosine(sw, [...loaded.vectors!.get(other)!.en]) }))
    .sort((a, b) => b.sim - a.sim)
  return { id, rank: ranked.findIndex((r) => r.other === id) + 1, own: round(ranked.find((r) => r.other === id)!.sim), best: ranked[0]!.other }
})
const norms = ids.flatMap((id) => (['en', 'sw'] as const).map((l) => Math.hypot(...loaded.vectors!.get(id)![l])))

const { cards, phrases } = loaded.content
const summary = {
  source: path.relative(PROJECT_ROOT, sourceDir),
  pack: { id: loaded.manifest.id, version: loaded.manifest.version, cards: cards.length, phrases: phrases.length, recordings: loaded.audio.size },
  bytes: {
    pack: signed.length,
    perFile: Object.fromEntries(loaded.manifest.files.map((f) => [f.path, f.size]))
  },
  build: {
    coldMs: Math.round(builds[0]!.totalMs),
    warmMs: Math.round(builds[1]!.totalMs),
    embedWarmMs: Math.round(builds[1]!.embedMs),
    signMs: round(signMs, 1),
    dims: loaded.manifest.embedding.dims
  },
  load: { medianMs: round(quantile(loadMs, 0.5), 2), p90Ms: round(quantile(loadMs, 0.9), 2) },
  tamperSweep: {
    flipped: positions.length,
    of: signed.length,
    exhaustive: !flipSample,
    audioStride,
    accepted: accepted.length,
    acceptedAt: accepted.slice(0, 20),
    byProblem,
    seconds: round(sweepMs / 1000, 1)
  },
  tamperSweepCrcRepaired: { ...repaired, audioStride, accepted: repaired.accepted.length, acceptedAt: repaired.accepted.slice(0, 20), seconds: round(repairedMs / 1000, 1) },
  recompute: { ms: Math.round(recomputeMs), status: recomputed.embeddings, minCosineToPacked: round(minCos, 6), maxAbsDiff: maxAbs },
  vectorNorm: { min: round(Math.min(...norms), 4), max: round(Math.max(...norms), 4) },
  crossLanguage: {
    top1: `${alignment.filter((a) => a.rank === 1).length}/${alignment.length}`,
    cards: alignment
  }
}
await fs.writeFile(path.join(outDir, 'packs-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
await runtime.unloadAll()
await shutdown()
