/**
 * PDF pages through pdf.js: the text layer with positions when the page has
 * one, or the page rendered to an image for OCR when it is a scan. Nothing is
 * fetched: fonts come from the pdfjs-dist package on disk. pdf.js 6 has no
 * eval path for the PDF's own code (fonts, functions), so there is nothing to
 * switch off.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import type { TextBox } from './layout.js'
import { DocumentError } from './input.js'

export interface PdfPageText {
  /** Page size in points. */
  width: number
  height: number
  /** Text items in points from the top-left corner. */
  boxes: TextBox[]
}

export interface RenderedPage {
  png: Uint8Array
  width: number
  height: number
  /** Pixels per point. */
  scale: number
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
type LoadingTask = ReturnType<PdfJs['getDocument']>
type PdfDocumentProxy = Awaited<LoadingTask['promise']>

let pdfjs: Promise<PdfJs> | undefined
const loadPdfJs = () => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'))

const pdfjsDir = () => path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))

export class PdfReader {
  private constructor(
    private readonly task: LoadingTask,
    private readonly doc: PdfDocumentProxy
  ) {}

  static async open(bytes: Uint8Array): Promise<PdfReader> {
    const { getDocument } = await loadPdfJs()
    const dir = pdfjsDir()
    // pdf.js takes ownership of (and detaches) the buffer it is given.
    const task = getDocument({
      data: new Uint8Array(bytes),
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: path.join(dir, 'standard_fonts') + path.sep,
      cMapUrl: path.join(dir, 'cmaps') + path.sep,
      cMapPacked: true,
      verbosity: 0
    })
    try {
      return new PdfReader(task, await task.promise)
    } catch (err) {
      await task.destroy()
      const e = err as Error
      if (e.name === 'PasswordException') throw new DocumentError('The PDF is password-protected. Open it, print it to a new PDF and try again.')
      throw new DocumentError(`Cannot read the PDF: ${e.message}`)
    }
  }

  get pageCount(): number {
    return this.doc.numPages
  }

  /** `page` counts from 1. */
  async text(page: number): Promise<PdfPageText> {
    const p = await this.doc.getPage(page)
    const { width, height } = p.getViewport({ scale: 1 })
    const content = await p.getTextContent()
    const boxes: TextBox[] = []
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const [a, b, c, d, e, f] = item.transform as number[]
      const size = Math.hypot(c!, d!) || Math.hypot(a!, b!)
      // Baseline at f (from the bottom). Padded like an OCR box (~1.25 em
      // tall), so layout treats line spacing alike for text and scans.
      const baseline = height - f!
      boxes.push({ text: item.str, bbox: [e!, baseline - 0.95 * size, e! + item.width, baseline + 0.3 * size] })
    }
    return { width, height, boxes: mergeRuns(boxes) }
  }

  /** Renders a page to PNG, `scale` pixels per point. */
  async render(page: number, scale: number): Promise<RenderedPage> {
    const { createCanvas } = await import('@napi-rs/canvas')
    const p = await this.doc.getPage(page)
    const viewport = p.getViewport({ scale })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    // pdf.js accepts @napi-rs/canvas in Node; its types name the DOM canvas.
    await p.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise
    p.cleanup()
    return { png: new Uint8Array(canvas.toBuffer('image/png')), width: canvas.width, height: canvas.height, scale }
  }

  async close(): Promise<void> {
    await this.task.destroy()
  }
}

/**
 * pdf.js splits a line wherever the font or spacing changes; pieces that
 * touch on the same baseline are one run of text again.
 */
function mergeRuns(boxes: TextBox[]): TextBox[] {
  const out: TextBox[] = []
  for (const box of boxes) {
    const prev = out[out.length - 1]
    const h = box.bbox[3] - box.bbox[1]
    if (prev && Math.abs(prev.bbox[3] - box.bbox[3]) < 0.2 * h && box.bbox[0] - prev.bbox[2] < 0.3 * h && box.bbox[0] >= prev.bbox[0]) {
      const gap = box.bbox[0] - prev.bbox[2] > 0.1 * h && !/\s$/.test(prev.text) && !/^\s/.test(box.text)
      prev.text += (gap ? ' ' : '') + box.text
      prev.bbox = [prev.bbox[0], Math.min(prev.bbox[1], box.bbox[1]), Math.max(prev.bbox[2], box.bbox[2]), Math.max(prev.bbox[3], box.bbox[3])]
    } else {
      out.push({ text: box.text, bbox: [...box.bbox] })
    }
  }
  return out.map((b) => ({ ...b, text: b.text.replace(/\s+/g, ' ').trim() }))
}
