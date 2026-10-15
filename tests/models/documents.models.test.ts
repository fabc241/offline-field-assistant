/**
 * F8 against the real OCR, translator and embedder (npm run fetch-models
 * first): the dev documents of eval/datasets/documents.json, rendered as a
 * photo, a scanned PDF and a PDF with text. The eval documents stay unseen.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MODEL_CATALOG as M, MODEL_SPECS } from '../../src/core/catalog.js'
import { loadConfig } from '../../src/core/config.js'
import { qvacEmbedder, qvacOcr, qvacTranslator } from '../../src/core/engines.js'
import { ModelStore } from '../../src/core/model-store.js'
import { QvacRuntime, createSdkPort, shutdown } from '../../src/core/qvac.js'
import { DocumentService } from '../../src/features/documents/document-service.js'
import { TranslationService } from '../../src/features/translate/translation-service.js'
import { loadDocuments, renderDocument, type RenderedDocument } from '../../eval/make-documents.js'

const config = loadConfig()
const store = await ModelStore.open(config.modelsDir)
const runtime = new QvacRuntime(store, createSdkPort(), config)
const installed = [M.ocrRecognizer, M.ocrDetector, M.translator, M.embedder].every((n) => store.has(n))
const service = new DocumentService(
  qvacOcr(runtime, MODEL_SPECS.ocr),
  new TranslationService(qvacTranslator(runtime, MODEL_SPECS.translator), qvacEmbedder(runtime, MODEL_SPECS.embedder))
)

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-docs-'))
const docs = new Map<string, RenderedDocument>()

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
  await runtime.unloadAll()
  await shutdown()
})

describe.skipIf(!installed)('document translate with real OCR and translator', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    for (const doc of (await loadDocuments()).filter((d) => d.set === 'dev')) docs.set(doc.id, await renderDocument(doc, dir))
  })

  it('reads a tilted phone photo of a card, field by field', async () => {
    const r = await service.read(docs.get('d01-appointment-card')!.file)
    expect(r).toMatchObject({ kind: 'jpeg', pages: [{ source: 'ocr', unit: 'px' }] })
    const text = r.segments.map((s) => s.text)
    expect(text.slice(0, 3)).toEqual(['NEXT APPOINTMENT', 'Name: Zawadi Mohamed', 'Clinic: Antenatal care'])
    // The wrapped sentence comes back as one segment.
    expect(text.some((t) => /^Bring your mother .* you are taking/.test(t))).toBe(true)
    expect(Math.min(...r.segments.map((s) => s.ocrConfidence!))).toBeGreaterThan(0.85)
  })

  it('OCRs a scanned PDF page, which has no text layer', async () => {
    const r = await service.read(docs.get('d02-dose-chart-sw')!.file)
    expect(r.pages).toMatchObject([{ source: 'ocr', unit: 'pt', width: 595, height: 842 }])
    expect(r.segments[0]!.text).toBe('JEDWALI LA DAWA YA MALARIA')
    expect(r.segments.some((s) => s.text.startsWith('Kilo 15 hadi 24: vidonge 2 mara mbili kwa siku'))).toBe(true)
  })

  it('translates a bilingual handout: English into Swahili, Swahili kept as printed', async () => {
    const r = await service.translate(docs.get('d03-handout-bilingual')!.file, 'sw')
    expect(r.pages).toMatchObject([{ source: 'text-layer' }])
    const wash = r.segments.find((s) => s.original.startsWith('Wash your hands'))!
    expect(wash.translation).toMatch(/mikono/i)
    expect(wash.translation).toMatch(/sabuni/i)
    expect(wash.translation).toMatch(/\b20\b/)
    expect(wash.flags).not.toContain('numbers-changed')
    const nawa = r.segments.find((s) => s.original.startsWith('Nawa mikono'))!
    expect(nawa).toMatchObject({ kept: 'target-language', translation: nawa.original })
  })

  it('flags the lines of a blurred, dark label it cannot read', async () => {
    const r = await service.translate(docs.get('d04-pharmacy-label-hard')!.file, 'sw', { check: false })
    expect(r.segments[0]!.original).toMatch(/^METFORMIN 500 mg/)
    expect(r.flags).toContain('low-confidence')
    expect(r.segments.filter((s) => s.flags.includes('low-confidence')).length).toBeGreaterThanOrEqual(3)
  })
})
