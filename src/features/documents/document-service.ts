/**
 * Document translate: a photo or PDF in, its text out as segments in reading
 * order, each translated with the F1 check.
 *
 * - Photos (PNG, JPEG, HEIC, …) are turned upright, straightened and OCR'd.
 * - PDFs give their text layer. A page with little or no text (a scan) is
 *   rendered, straightened and OCR'd instead.
 *
 * Every segment keeps its page and box, so a screen can lay the translation
 * over the original. OCR'd text the engine was unsure of is flagged
 * `low-confidence`: it is still translated (flags never block, as in F1),
 * but the flag comes first so nobody takes a misread dose at face value.
 */
import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import type { Lang, OcrBlock, OcrEngine } from '../../core/engines.js'
import { FLAGS, type CheckedTranslation, type Flag, type TranslationService } from '../translate/translation-service.js'
import { straighten } from './deskew.js'
import { DEFAULT_MAX_SIDE, DocumentError, detectKind, prepareImage, type DocumentKind } from './input.js'
import { guessLang, hasWords } from './language.js'
import { layout, type BBox, type TextBox } from './layout.js'
import { PdfReader } from './pdf.js'

export const DOC_FLAGS = ['low-confidence', ...FLAGS] as const
export type DocFlag = (typeof DOC_FLAGS)[number]

export const DOC_FLAG_HELP: Record<'low-confidence', string> = {
  'low-confidence': 'The text was hard to read. Compare it with the paper before relying on it.'
}

export type TextSource = 'text-layer' | 'ocr'

export interface DocPage {
  /** From 1. */
  page: number
  width: number
  height: number
  /** Points for a PDF, pixels of the upright photo for an image. Boxes use the same unit. */
  unit: 'pt' | 'px'
  source: TextSource
  /** Text extraction, or rendering plus OCR. */
  readMs: number
}

export interface SourceSegment {
  page: number
  bbox: BBox
  source: TextSource
  text: string
  /** Lowest line confidence, 0–1; null for a text layer. */
  ocrConfidence: number | null
}

export interface ReadDocument {
  kind: DocumentKind
  pages: DocPage[]
  segments: SourceSegment[]
  readMs: number
}

export interface DocSegment {
  page: number
  bbox: BBox
  source: TextSource
  original: string
  translation: string
  /** Why the original was kept instead of translated. */
  kept?: 'target-language' | 'no-words'
  backTranslation?: string
  fidelity?: number
  ocrConfidence: number | null
  /** Most severe first. */
  flags: DocFlag[]
}

export interface DocTranslation {
  kind: DocumentKind
  from: Lang
  to: Lang
  pages: DocPage[]
  segments: DocSegment[]
  /** Every flag raised on any segment, most severe first. */
  flags: DocFlag[]
  timings: { readMs: number; translateMs: number; checkMs: number; totalMs: number }
}

export interface DocumentOptions {
  /**
   * OCR lines below this (length-normalized, see `lineConfidence`) are flagged
   * `low-confidence`. Chosen on the dev documents (eval/RESULTS.md, F8).
   */
  minConfidence?: number
  /** A PDF page with fewer letters and digits than this in its text layer is OCR'd. */
  minTextChars?: number
  /** Long-side cap for photos and rendered PDF pages, in pixels. */
  maxSide?: number
  /** Straighten tilted photos and scans before OCR (default true; off for the F8 A/B). */
  deskew?: boolean
  /** Length-normalize OCR confidences (default true; off for the F8 A/B). */
  normalizeConfidence?: boolean
}

export interface TranslateOptions {
  /** Back-translate and check each segment (default true). */
  check?: boolean
  /** Each segment as soon as it is done, in order. */
  onSegment?: (segment: DocSegment, index: number, total: number) => void
}

/**
 * Midway in the gap on the dev documents: misread segments up to 0.77,
 * clean ones from 0.92 (eval/RESULTS.md, F8). Single-letter misreads score
 * higher still, so this catches the badly read lines, not every slip.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.85
export const DEFAULT_MIN_TEXT_CHARS = 20
/** Scanned pages render at up to 3 px per point (216 dpi). */
const MAX_PDF_SCALE = 3

/**
 * The recognizer reports a line's confidence as the product of its
 * per-character probabilities raised to 2/√n (EasyOCR's `custom_mean`), so a
 * long line read perfectly can score 0.6 while a short misread one scores 0.8.
 * Undoing the exponent gives the per-character geometric mean, which does not
 * depend on length.
 */
export function lineConfidence(raw: number, text: string): number {
  const n = [...text.replace(/\s/g, '')].length
  if (n === 0 || raw <= 0) return 0
  return raw ** (1 / (2 * Math.sqrt(n)))
}

export class DocumentService {
  private readonly minConfidence: number
  private readonly minTextChars: number
  private readonly maxSide: number
  private readonly deskew: boolean
  private readonly normalizeConfidence: boolean

  constructor(
    private readonly ocr: OcrEngine,
    private readonly translation: TranslationService,
    opts: DocumentOptions = {}
  ) {
    this.minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE
    this.minTextChars = opts.minTextChars ?? DEFAULT_MIN_TEXT_CHARS
    this.maxSide = opts.maxSide ?? DEFAULT_MAX_SIDE
    this.deskew = opts.deskew ?? true
    this.normalizeConfidence = opts.normalizeConfidence ?? true
  }

  /** The text of a document, by segment, without translating it. `input` is a path or the file's bytes. */
  async read(input: string | Uint8Array): Promise<ReadDocument> {
    const t0 = performance.now()
    const bytes = typeof input === 'string' ? new Uint8Array(await fs.readFile(input)) : input
    const kind = detectKind(bytes)
    if (!kind) throw new DocumentError('Not a PDF or a photo this app can read (PNG, JPEG, HEIC, BMP, WebP, TIFF).')

    const pages: DocPage[] = []
    const segments: SourceSegment[] = []
    if (kind === 'pdf') {
      const pdf = await PdfReader.open(bytes)
      try {
        for (let page = 1; page <= pdf.pageCount; page++) {
          const { info, boxes, toPage } = await this.readPdfPage(pdf, page)
          pages.push(info)
          segments.push(...this.toSegments(boxes, page, info.source, toPage))
        }
      } finally {
        await pdf.close()
      }
    } else {
      const t1 = performance.now()
      const image = await prepareImage(bytes, kind, { maxSide: this.maxSide })
      const found = await this.recognize(image.png, image.width, image.height, image.originalWidth / image.width)
      pages.push({ page: 1, width: image.originalWidth, height: image.originalHeight, unit: 'px', source: 'ocr', readMs: performance.now() - t1 })
      segments.push(...this.toSegments(found.boxes, 1, 'ocr', found.toPage))
    }
    return { kind, pages, segments, readMs: performance.now() - t0 }
  }

  /** Reads a document and translates it into `to`; segments already in `to` are kept as they are. */
  async translate(input: string | Uint8Array | ReadDocument, to: Lang, opts: TranslateOptions = {}): Promise<DocTranslation> {
    const t0 = performance.now()
    const doc = typeof input === 'object' && 'segments' in input ? input : await this.read(input)
    const from: Lang = to === 'en' ? 'sw' : 'en'
    const check = opts.check ?? true
    let translateMs = 0
    let checkMs = 0

    const segments: DocSegment[] = []
    for (const [i, s] of doc.segments.entries()) {
      const base = { page: s.page, bbox: s.bbox, source: s.source, original: s.text, ocrConfidence: s.ocrConfidence }
      const ocrFlags: DocFlag[] = s.ocrConfidence !== null && s.ocrConfidence < this.minConfidence ? ['low-confidence'] : []
      const guess = guessLang(s.text)
      let segment: DocSegment
      if (!hasWords(s.text)) {
        segment = { ...base, translation: s.text, kept: 'no-words', flags: ocrFlags }
      } else if (guess.lang === to && guess.margin >= 2) {
        segment = { ...base, translation: s.text, kept: 'target-language', flags: ocrFlags }
      } else {
        const t = await this.translation.translate(s.text, from, to)
        translateMs += t.translateMs
        let checked: CheckedTranslation | undefined
        if (check) {
          const t1 = performance.now()
          checked = await this.translation.check(t)
          checkMs += performance.now() - t1
        }
        const flags = new Set<DocFlag>([...ocrFlags, ...(checked?.flags ?? (t.translation ? [] : (['empty-output'] as Flag[])))])
        segment = {
          ...base,
          translation: t.translation,
          ...(checked ? { backTranslation: checked.backTranslation, fidelity: checked.fidelity } : {}),
          flags: DOC_FLAGS.filter((f) => flags.has(f))
        }
      }
      segments.push(segment)
      opts.onSegment?.(segment, i, doc.segments.length)
    }

    const raised = new Set(segments.flatMap((s) => s.flags))
    return {
      kind: doc.kind,
      from,
      to,
      pages: doc.pages,
      segments,
      flags: DOC_FLAGS.filter((f) => raised.has(f)),
      timings: { readMs: doc.readMs, translateMs, checkMs, totalMs: doc.readMs + performance.now() - t0 }
    }
  }

  private async readPdfPage(pdf: PdfReader, page: number): Promise<{ info: DocPage; boxes: TextBox[]; toPage?: (b: BBox) => BBox }> {
    const t0 = performance.now()
    const text = await pdf.text(page)
    const chars = text.boxes.reduce((n, b) => n + (b.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0)
    if (chars >= this.minTextChars) {
      const info: DocPage = { page, width: text.width, height: text.height, unit: 'pt', source: 'text-layer', readMs: performance.now() - t0 }
      return { info, boxes: text.boxes }
    }
    // A scan: render it and read the pixels.
    const scale = Math.min(MAX_PDF_SCALE, this.maxSide / Math.max(text.width, text.height))
    const rendered = await pdf.render(page, scale)
    const found = await this.recognize(rendered.png, rendered.width, rendered.height, 1 / scale)
    const info: DocPage = { page, width: text.width, height: text.height, unit: 'pt', source: 'ocr', readMs: performance.now() - t0 }
    return { info, ...found }
  }

  /**
   * OCR lines of a straightened copy of the image, with normalized
   * confidences. Boxes stay in the straightened image, where lines are level,
   * for layout; `toPage` maps a box back to the page, `toPageUnits` per pixel.
   */
  private async recognize(png: Uint8Array, width: number, height: number, toPageUnits: number) {
    const level = this.deskew ? await straighten(png, width, height) : { png, toInput: (b: BBox) => b }
    const blocks: OcrBlock[] = await this.ocr.recognize(level.png)
    const confidence = (b: OcrBlock) => (this.normalizeConfidence ? lineConfidence(b.confidence ?? 0, b.text) : (b.confidence ?? 0))
    const boxes: TextBox[] = blocks
      .filter((b): b is OcrBlock & { bbox: BBox } => Boolean(b.bbox && b.text.trim()))
      .map((b) => ({ text: b.text.trim(), bbox: b.bbox, confidence: confidence(b) }))
    const toPage = (b: BBox) => level.toInput(b).map((v) => v * toPageUnits) as BBox
    return { boxes, toPage }
  }

  private toSegments(boxes: TextBox[], page: number, source: TextSource, toPage: (b: BBox) => BBox = (b) => b): SourceSegment[] {
    return layout(boxes).map((block) => ({
      page,
      bbox: toPage(block.bbox).map(round1) as BBox,
      source,
      text: block.text,
      ocrConfidence: source === 'ocr' ? round3(block.confidence ?? 0) : null
    }))
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10
const round3 = (x: number) => Math.round(x * 1000) / 1000
