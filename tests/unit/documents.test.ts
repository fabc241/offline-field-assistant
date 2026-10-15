import { createCanvas } from '@napi-rs/canvas'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { EmbedTask, Embedder, Lang, OcrBlock, OcrEngine, Translator } from '../../src/core/engines.js'
import { estimateSkew, straighten } from '../../src/features/documents/deskew.js'
import { DEFAULT_MIN_CONFIDENCE, DocumentService, lineConfidence } from '../../src/features/documents/document-service.js'
import { DocumentError, detectKind, prepareImage } from '../../src/features/documents/input.js'
import { guessLang, hasWords } from '../../src/features/documents/language.js'
import { layout, readingOrder, toBlocks, toLines, type BBox, type TextBox } from '../../src/features/documents/layout.js'
import { PdfReader } from '../../src/features/documents/pdf.js'
import { TranslationService } from '../../src/features/translate/translation-service.js'
import { writePdf, type PdfPage } from '../../eval/pdf-writer.js'

/** Prefixes the target language; the embedder sees every round trip as faithful. */
class TagTranslator implements Translator {
  calls: [string, Lang, Lang][] = []
  async translate(text: string, from: Lang, to: Lang) {
    this.calls.push([text, from, to])
    return text.startsWith(`[${from}] `) ? text.slice(5) : `[${to}] ${text}`
  }
}
class SameEmbedder implements Embedder {
  async embed(texts: string[], _task: EmbedTask) {
    return texts.map(() => [1, 0])
  }
}
/** Returns canned lines and records the images it was given. */
class FakeOcr implements OcrEngine {
  images: Uint8Array[] = []
  constructor(private readonly blocks: OcrBlock[]) {}
  async recognize(image: Uint8Array) {
    this.images.push(image)
    return this.blocks
  }
}

const box = (text: string, bbox: BBox, confidence?: number): TextBox => ({ text, bbox, ...(confidence !== undefined ? { confidence } : {}) })
const texts = (boxes: TextBox[]) => layout(boxes).map((b) => b.text)

function service(ocr: OcrEngine, translator = new TagTranslator()) {
  return { svc: new DocumentService(ocr, new TranslationService(translator, new SameEmbedder())), translator }
}

/** A white image with dark bars where text would be, 20 px tall rows. */
async function textImage(width: number, height: number, rows = 6): Promise<Buffer> {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#111'
  ctx.font = '22px Helvetica'
  for (let i = 0; i < rows; i++) ctx.fillText('Take two tablets every eight hours with food.', 30, 50 + i * 45)
  return canvas.toBuffer('image/png')
}

const textPdf = (items: PdfPage['items'], width = 595, height = 842) => writePdf([{ width, height, items }])

describe('detectKind', () => {
  it('knows a file by its bytes, not its name', () => {
    const b = (...xs: (number | string)[]) => new Uint8Array(xs.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])))
    expect(detectKind(b('%PDF-1.7\n'))).toBe('pdf')
    expect(detectKind(b(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('png')
    expect(detectKind(b(0xff, 0xd8, 0xff, 0xe1))).toBe('jpeg')
    expect(detectKind(b(0, 0, 0, 24, 'ftypheic'))).toBe('heic')
    expect(detectKind(b('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('webp')
    expect(detectKind(b('BM', 0, 0))).toBe('bmp')
    expect(detectKind(b('hello world'))).toBeUndefined()
  })
})

describe('layout', () => {
  it('joins the pieces of one line and splits a row where the gap is wide', () => {
    // As the engine boxed one printed line of a label photo.
    const lines = toLines([
      box('day', [574, 330, 645, 377]),
      box('capsule three times a', [250, 332, 577, 376]),
      box('Take', [147, 334, 222, 367]),
      box('for 5', [642, 335, 715, 367]),
      box('1', [229, 339, 245, 362]), // half as tall as its neighbours
      box('Weight: 14.5 kg', [900, 333, 1100, 375])
    ])
    expect(lines.map((l) => l.text)).toEqual(['Take 1 capsule three times a day for 5', 'Weight: 14.5 kg'])
    // A short box inside a wide one does not cut the line.
    expect(toLines([box('Take two tablets', [100, 100, 600, 140]), box('1', [300, 105, 320, 135]), box('daily', [610, 100, 700, 140])]).map((l) => l.text)).toEqual([
      'Take two tablets 1 daily'
    ])
  })

  it('wraps a paragraph back into one segment but keeps fields, sentences and languages apart', () => {
    const h = 44
    const row = (text: string, i: number, x1 = 700) => box(text, [100, 300 + i * 41, x1, 300 + i * 41 + h])
    expect(
      texts([
        row('Take 1 capsule three times a day for 5', 0),
        row('days and finish all the capsules', 1, 560),
        // A new row: wider gap.
        box('Do not give to a child under 6 months', [100, 460, 690, 460 + h])
      ])
    ).toEqual(['Take 1 capsule three times a day for 5 days and finish all the capsules', 'Do not give to a child under 6 months'])

    // Lines this close are still separate when one ends a sentence, the next
    // starts a field, or the language changes (OCR dropped the full stop).
    expect(texts([row('Mix one sachet in clean water.', 0), row('Then give small sips', 1)])).toHaveLength(2)
    expect(texts([row('Name of the patient here please', 0), row('Date of birth: 12/03/2019', 1)])).toHaveLength(2)
    expect(texts([row('Give small sips after each loose stool', 0), row('Mpe mafunda madogo baada ya kila choo laini', 1)])).toHaveLength(2)
  })

  it('undoes a hyphen that split a word', () => {
    expect(texts([box('Give the medi-', [100, 100, 600, 140]), box('cine with food', [100, 138, 400, 178])])).toEqual(['Give the medicine with food'])
  })

  it('keeps a heading apart from the body under it', () => {
    expect(texts([box('REASON FOR VISIT', [100, 100, 500, 160]), box('fever and vomiting since', [100, 150, 450, 190])])).toHaveLength(2)
  })

  it('reads top to bottom, and left to right on a row', () => {
    const blocks = toBlocks([
      { text: 'Weight: 14.5 kg', bbox: [300, 102, 400, 120] },
      { text: 'Name: Amina', bbox: [50, 100, 150, 120] },
      { text: 'Title', bbox: [50, 40, 200, 70] }
    ])
    expect(blocks.map((b) => b.text)).toEqual(['Title', 'Name: Amina', 'Weight: 14.5 kg'])
    expect(readingOrder([{ bbox: [10, 300, 20, 320] as BBox }, { bbox: [10, 10, 20, 30] as BBox }])[0]!.bbox[1]).toBe(10)
  })

  it('takes the lowest line confidence for a block', () => {
    const [b] = layout([box('Take 1 capsule three times a day for 5', [100, 300, 700, 344], 0.99), box('days with food', [100, 341, 400, 385], 0.7)])
    expect(b!.confidence).toBe(0.7)
  })
})

describe('guessLang', () => {
  it('tells English from Swahili, and says when it is unsure', () => {
    expect(guessLang('Mtoto ana homa na kutapika tangu jana.')).toMatchObject({ lang: 'sw' })
    expect(guessLang('Changanya pakiti moja na lita 1 ya maji safi.').margin).toBeGreaterThanOrEqual(2)
    expect(guessLang('Take 2 tablets every 8 hours for 5 days.')).toMatchObject({ lang: 'en' })
    expect(guessLang('Throw away what is left after 24 hours.').margin).toBeGreaterThanOrEqual(2)
    // Names and numbers are no evidence either way.
    expect(guessLang('Amina Juma').margin).toBeLessThan(2)
    expect(guessLang('Weight: 14.5 kg').margin).toBeLessThan(2)
    expect(hasWords('12/03/2019')).toBe(false)
    expect(hasWords('14.5 kg')).toBe(false)
    expect(hasWords('Pulse: 128')).toBe(true)
  })
})

describe('lineConfidence', () => {
  it('undoes the length penalty of the engine score', () => {
    // A 52-letter line read perfectly scored 0.59; a 5-letter one with a slip 0.76.
    expect(lineConfidence(0.586, 'Take 2 tablets every 8 hours for 5 days. Do not take')).toBeGreaterThan(0.95)
    expect(lineConfidence(0.76, 'on an')).toBeLessThan(lineConfidence(0.586, 'Take 2 tablets every 8 hours for 5 days. Do not take'))
    expect(lineConfidence(1, 'x')).toBe(1)
    expect(lineConfidence(0, 'abc')).toBe(0)
    expect(lineConfidence(0.5, '   ')).toBe(0)
  })
})

describe('deskew', () => {
  it('finds the tilt of a photographed page and maps boxes back', async () => {
    const png = await textImage(900, 360)
    for (const angle of [-4, 2.5]) {
      const tilted = await sharp(png).rotate(angle, { background: '#7d7364' }).png().toBuffer()
      expect(Math.abs((await estimateSkew(tilted)) - angle)).toBeLessThan(0.2)
    }
    expect(Math.abs(await estimateSkew(png))).toBeLessThan(0.2)

    const tilted = await sharp(png).rotate(3, { background: '#ffffff' }).png().toBuffer()
    const meta = await sharp(tilted).metadata()
    const level = await straighten(tilted, meta.width!, meta.height!)
    expect(level.angle).toBeCloseTo(3, 0)
    // The centre of the straightened page is the centre of the input.
    const [x0, y0, x1, y1] = level.toInput([level.width / 2 - 1, level.height / 2 - 1, level.width / 2 + 1, level.height / 2 + 1])
    expect((x0 + x1) / 2).toBeCloseTo(meta.width! / 2, 0)
    expect((y0 + y1) / 2).toBeCloseTo(meta.height! / 2, 0)
  })

  it('leaves a level page alone', async () => {
    const png = await textImage(900, 360)
    const level = await straighten(png, 900, 360)
    expect(level.angle).toBe(0)
    expect(level.png).toBe(png)
  })
})

describe('prepareImage', () => {
  it('turns a sideways phone photo upright and caps its size', async () => {
    const upright = await sharp(await textImage(1200, 600)).jpeg().toBuffer()
    // Stored rotated, with EXIF saying "turn 90° clockwise to view".
    const sideways = await sharp(upright).rotate(270).withMetadata({ orientation: 6 }).jpeg().toBuffer()
    const img = await prepareImage(new Uint8Array(sideways), 'jpeg', { maxSide: 800 })
    expect([img.originalWidth, img.originalHeight]).toEqual([1200, 600])
    expect([img.width, img.height]).toEqual([800, 400])
    expect(detectKind(img.png)).toBe('png')
  })

  it('reports an unreadable image as a document error', async () => {
    await expect(prepareImage(new Uint8Array([0xff, 0xd8, 0xff, 0, 1, 2]), 'jpeg')).rejects.toBeInstanceOf(DocumentError)
  })

  it.skipIf(process.platform !== 'darwin')('reads an iPhone HEIC photo through macOS', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-test-'))
    try {
      await fs.writeFile(path.join(dir, 'a.png'), await textImage(640, 320))
      await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'heic', path.join(dir, 'a.png'), '--out', path.join(dir, 'a.heic')])
      const bytes = new Uint8Array(await fs.readFile(path.join(dir, 'a.heic')))
      expect(detectKind(bytes)).toBe('heic')
      const img = await prepareImage(bytes, 'heic')
      expect([img.width, img.height]).toEqual([640, 320])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('PdfReader', () => {
  it('gives the text layer with boxes in points from the top-left corner', async () => {
    const pdf = await PdfReader.open(
      textPdf([
        { kind: 'text', x: 50, y: 100, size: 12, font: 'Helvetica', text: 'Name: Amina Juma' },
        { kind: 'text', x: 300, y: 100, size: 12, font: 'Helvetica', text: 'Weight: 14.5 kg' }
      ])
    )
    expect(pdf.pageCount).toBe(1)
    const page = await pdf.text(1)
    expect([page.width, page.height]).toEqual([595, 842])
    expect(page.boxes.map((b) => b.text)).toEqual(['Name: Amina Juma', 'Weight: 14.5 kg'])
    const [x0, y0, , y1] = page.boxes[0]!.bbox
    expect(x0).toBeCloseTo(50)
    expect(y0).toBeLessThan(100) // above the baseline
    expect(y1).toBeGreaterThan(100) // descenders below it
    const rendered = await pdf.render(1, 2)
    expect([rendered.width, rendered.height]).toEqual([1190, 1684])
    expect(detectKind(rendered.png)).toBe('png')
    await pdf.close()
  })

  it('refuses a file that is not a PDF', async () => {
    await expect(PdfReader.open(new TextEncoder().encode('%PDF-1.4 garbage'))).rejects.toBeInstanceOf(DocumentError)
  })
})

describe('DocumentService', () => {
  it('translates a text PDF by its text layer, without OCR', async () => {
    const ocr = new FakeOcr([])
    const { svc, translator } = service(ocr)
    const pdf = textPdf([
      { kind: 'text', x: 50, y: 80, size: 18, font: 'Helvetica-Bold', text: 'DISCHARGE INSTRUCTIONS' },
      { kind: 'text', x: 50, y: 120, size: 11, font: 'Helvetica', text: 'Take 2 tablets every 8 hours for 5 days and do not' },
      { kind: 'text', x: 50, y: 134, size: 11, font: 'Helvetica', text: 'take them on an empty stomach.' },
      { kind: 'text', x: 50, y: 170, size: 11, font: 'Helvetica', text: '12/03/2019' },
      { kind: 'text', x: 50, y: 200, size: 11, font: 'Helvetica', text: 'Mtoto ana homa na kutapika tangu jana.' }
    ])
    const r = await svc.translate(pdf, 'sw')
    expect(ocr.images).toHaveLength(0)
    expect(r).toMatchObject({ kind: 'pdf', from: 'en', to: 'sw', pages: [{ page: 1, unit: 'pt', source: 'text-layer' }] })
    expect(r.segments.map((s) => [s.original, s.translation, s.kept])).toEqual([
      ['DISCHARGE INSTRUCTIONS', '[sw] DISCHARGE INSTRUCTIONS', undefined],
      ['Take 2 tablets every 8 hours for 5 days and do not take them on an empty stomach.', '[sw] Take 2 tablets every 8 hours for 5 days and do not take them on an empty stomach.', undefined],
      ['12/03/2019', '12/03/2019', 'no-words'],
      ['Mtoto ana homa na kutapika tangu jana.', 'Mtoto ana homa na kutapika tangu jana.', 'target-language']
    ])
    expect(r.segments[1]).toMatchObject({ source: 'text-layer', ocrConfidence: null, backTranslation: 'Take 2 tablets every 8 hours for 5 days and do not take them on an empty stomach.', fidelity: 1, flags: [] })
    // Only the two English segments went through the translator (and back).
    expect(translator.calls.filter((c) => c[1] === 'en')).toHaveLength(2)
  })

  it('OCRs a scanned page, puts the boxes in points and flags what it could not read well', async () => {
    const ocr = new FakeOcr([
      { text: 'CHILD HEALTH CARD', bbox: [150, 150, 900, 210], confidence: 0.99 },
      { text: 'Polio 1: 16/03/2026', bbox: [150, 300, 700, 350], confidence: 0.2 }
    ])
    const { svc } = service(ocr)
    const jpeg = await sharp({ create: { width: 840, height: 600, channels: 3, background: '#ffffff' } }).jpeg().toBuffer()
    const pdf = writePdf([{ width: 420, height: 300, items: [{ kind: 'image', jpeg, pixelWidth: 840, pixelHeight: 600, x: 0, y: 0, width: 420, height: 300 }] }])
    const r = await svc.translate(pdf, 'sw', { check: false })
    expect(ocr.images).toHaveLength(1)
    expect(r.pages[0]).toMatchObject({ source: 'ocr', unit: 'pt', width: 420, height: 300 })
    // Rendered at 3 px per point: pixel 150 is point 50.
    expect(r.segments[0]!.bbox).toEqual([50, 50, 300, 70])
    expect(r.segments[0]).toMatchObject({ source: 'ocr', flags: [], translation: '[sw] CHILD HEALTH CARD' })
    expect(r.segments[0]!.backTranslation).toBeUndefined()
    expect(r.segments[1]!.flags).toEqual(['low-confidence'])
    expect(r.segments[1]!.ocrConfidence).toBeLessThan(DEFAULT_MIN_CONFIDENCE)
    expect(r.flags).toEqual(['low-confidence'])
  })

  it('reads a photo, with boxes in the pixels of the original', async () => {
    const ocr = new FakeOcr([{ text: 'Kunywa maji safi kila siku', bbox: [100, 50, 500, 90], confidence: 1 }])
    const { svc } = service(ocr)
    const big = await sharp(await textImage(1200, 600, 0)).jpeg().toBuffer() // blank: no tilt to remove
    const r = await new DocumentService(ocr, new TranslationService(new TagTranslator(), new SameEmbedder()), { maxSide: 600 }).read(new Uint8Array(big))
    expect(detectKind(ocr.images[0]!)).toBe('png')
    expect(r.pages[0]).toMatchObject({ unit: 'px', width: 1200, height: 600, source: 'ocr' })
    expect(r.segments[0]!.bbox).toEqual([200, 100, 1000, 180])
    const t = await svc.translate(r, 'en')
    expect(t).toMatchObject({ from: 'sw', to: 'en' })
    expect(t.segments[0]!.translation).toBe('[en] Kunywa maji safi kila siku')
  })

  it('refuses a file that is neither a PDF nor a photo', async () => {
    const { svc } = service(new FakeOcr([]))
    await expect(svc.read(new TextEncoder().encode('Name,Age\nAmina,4\n'))).rejects.toThrow(/Not a PDF or a photo/)
  })

  it('returns no segments for a page with no text', async () => {
    const { svc } = service(new FakeOcr([]))
    const blank = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } }).png().toBuffer()
    const r = await svc.translate(new Uint8Array(blank), 'sw')
    expect(r.segments).toEqual([])
    expect(r.flags).toEqual([])
  })
})
