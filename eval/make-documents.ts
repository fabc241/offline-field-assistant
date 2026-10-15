/**
 * Renders the F8 eval documents (eval/datasets/documents.json) into
 * var/eval-docs/: PDFs with a text layer, scanned PDFs (a JPEG per page, no
 * text) and phone photos (tilted, unevenly lit, blurred, noisy, JPEG or HEIC,
 * one stored sideways with an EXIF orientation). The text is laid out exactly
 * as written, so the dataset is the ground truth. Noise is seeded: the same
 * dataset always renders the same files.
 *
 *   npx tsx eval/make-documents.ts
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import sharp, { type Sharp } from 'sharp'
import { PROJECT_ROOT } from '../src/core/config.js'
import { writePdf, type PdfPage, type PdfText, type StandardFont } from './pdf-writer.js'

export const EVAL_DOCS_DIR = path.join(PROJECT_ROOT, 'var/eval-docs')

type Format = 'pdf-text' | 'pdf-scan' | 'photo-jpeg' | 'photo-heic' | 'png'
type Paper = 'a4' | 'label' | 'card'
type Family = 'Helvetica' | 'Times-Roman' | 'Courier'

export interface Block {
  lines: string[]
  size: number
  bold?: boolean
  /** Left edge as a share of the text width (a second column). */
  x?: number
}

interface Degrade {
  rotate?: number
  blur?: number
  /** Standard deviation of the pixel noise, 0–255. */
  noise?: number
  /** Darkening toward one corner, 0–1. */
  shade?: number
  scale?: number
  jpegQuality?: number
  exifOrientation?: 6
}

export interface EvalDocument {
  id: string
  set: 'eval' | 'dev'
  title: string
  format: Format
  paper: Paper
  font: Family
  /** Space between rows, in line heights (default 0.9). */
  rowGap?: number
  degrade?: Degrade
  /** Pages → rows → blocks side by side. */
  pages: Block[][][]
}

export interface RenderedDocument extends EvalDocument {
  file: string
  /** Each page's blocks in reading order: the segments a reader expects. */
  truth: string[][]
}

/** Points; margin on every side. */
const PAPER: Record<Paper, { width: number; height: number; margin: number; dpi: number }> = {
  a4: { width: 595, height: 842, margin: 50, dpi: 150 },
  label: { width: 360, height: 220, margin: 18, dpi: 300 },
  card: { width: 420, height: 300, margin: 22, dpi: 200 }
}
const LINE_PITCH = 1.25
const CANVAS_FONT: Record<Family, string> = { Helvetica: 'Helvetica', 'Times-Roman': 'Times New Roman', Courier: 'Courier New' }
const PDF_FONT: Record<Family, [StandardFont, StandardFont]> = {
  Helvetica: ['Helvetica', 'Helvetica-Bold'],
  'Times-Roman': ['Times-Roman', 'Times-Bold'],
  Courier: ['Courier', 'Courier-Bold']
}
const TABLE = '#7d7364'

export async function loadDocuments(): Promise<EvalDocument[]> {
  const raw = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'eval/datasets/documents.json'), 'utf8')) as { documents: EvalDocument[] }
  return raw.documents
}

const blockText = (b: Block) => b.lines.join(' ')

/** Text runs of one page, placed in points. */
function placeText(doc: EvalDocument, page: Block[][]): PdfText[] {
  const paper = PAPER[doc.paper]
  const textWidth = paper.width - 2 * paper.margin
  const measure = createCanvas(10, 10).getContext('2d')
  const items: PdfText[] = []
  let y = paper.margin
  for (const row of page) {
    const rowSize = Math.max(...row.map((b) => b.size))
    for (const block of row) {
      const x = paper.margin + (block.x ?? 0) * textWidth
      const font = PDF_FONT[doc.font][block.bold ? 1 : 0]
      measure.font = `${block.bold ? 'bold ' : ''}${block.size}px "${CANVAS_FONT[doc.font]}"`
      for (const [i, text] of block.lines.entries()) {
        const right = x + measure.measureText(text).width
        if (right > paper.width - paper.margin + 1) throw new Error(`${doc.id}: "${text}" runs off the ${doc.paper}`)
        items.push({ kind: 'text', x, y: y + 0.95 * block.size + i * LINE_PITCH * block.size, size: block.size, font, text })
      }
    }
    y += Math.max(...row.map((b) => b.lines.length * LINE_PITCH * b.size)) + (doc.rowGap ?? 0.9) * rowSize
    if (y > paper.height - paper.margin + 1) throw new Error(`${doc.id}: page overflows the ${doc.paper}`)
  }
  return items
}

/** The page as a clean image at the paper's dpi. */
function drawPage(doc: EvalDocument, items: PdfText[]): Buffer {
  const paper = PAPER[doc.paper]
  const k = paper.dpi / 72
  const canvas = createCanvas(Math.round(paper.width * k), Math.round(paper.height * k))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fbfaf6'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#1a1a1a'
  for (const item of items) {
    const bold = item.font.endsWith('Bold')
    ctx.font = `${bold ? 'bold ' : ''}${item.size * k}px "${CANVAS_FONT[doc.font]}"`
    ctx.fillText(item.text, item.x * k, item.y * k)
  }
  return canvas.toBuffer('image/png')
}

/** Seeded PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const seedOf = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261)

/** A phone photo of the page: on a table, tilted, shaded, blurred, noisy, resized. Returns raw RGB. */
async function photograph(png: Buffer, d: Degrade, seed: string): Promise<Sharp> {
  let img = sharp(png).removeAlpha()
  const { width, height } = await img.metadata()
  if (d.shade) {
    const svg = `<svg width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="rgb(${Math.round(255 * (1 - d.shade))},${Math.round(250 * (1 - d.shade))},${Math.round(240 * (1 - d.shade))})"/>` +
      `</linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`
    img = sharp(await img.composite([{ input: Buffer.from(svg), blend: 'multiply' }]).png().toBuffer())
  }
  const pad = Math.round(0.05 * Math.max(width!, height!))
  img = sharp(await img.extend({ top: pad, bottom: pad, left: pad, right: pad, background: TABLE }).png().toBuffer())
  if (d.rotate) img = sharp(await img.rotate(d.rotate, { background: TABLE }).png().toBuffer())
  if (d.blur) img = sharp(await img.blur(Math.max(0.3, d.blur)).png().toBuffer())
  if (d.scale && d.scale !== 1) {
    const m = await img.metadata()
    img = sharp(await img.resize(Math.round(m.width! * d.scale)).png().toBuffer())
  }
  if (d.noise) {
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
    const rand = rng(seedOf(seed))
    for (let i = 0; i < data.length; i += info.channels) {
      // Luminance noise (Box–Muller), the same on every channel, like a sensor.
      const n = d.noise * Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand())
      for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, data[i + c]! + n))
    }
    img = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
  }
  return img
}

async function scanPdf(doc: EvalDocument, pages: PdfText[][]): Promise<Uint8Array> {
  const paper = PAPER[doc.paper]
  const out: PdfPage[] = []
  for (const [i, items] of pages.entries()) {
    const photo = await photograph(drawPage(doc, items), { ...doc.degrade, scale: doc.degrade?.scale ?? 1 }, `${doc.id}/${i}`)
    const jpeg = await photo.jpeg({ quality: doc.degrade?.jpegQuality ?? 80 }).toBuffer({ resolveWithObject: true })
    out.push({
      width: paper.width,
      height: paper.height,
      items: [{ kind: 'image', jpeg: jpeg.data, pixelWidth: jpeg.info.width, pixelHeight: jpeg.info.height, x: 0, y: 0, width: paper.width, height: paper.height }]
    })
  }
  return writePdf(out)
}

const EXTENSION: Record<Format, string> = { 'pdf-text': 'pdf', 'pdf-scan': 'pdf', 'photo-jpeg': 'jpg', 'photo-heic': 'heic', png: 'png' }

export async function renderDocument(doc: EvalDocument, dir = EVAL_DOCS_DIR): Promise<RenderedDocument> {
  const pages = doc.pages.map((page) => placeText(doc, page))
  const file = path.join(dir, `${doc.id}.${EXTENSION[doc.format]}`)
  const d = doc.degrade ?? {}
  switch (doc.format) {
    case 'pdf-text': {
      const paper = PAPER[doc.paper]
      await fs.writeFile(file, writePdf(pages.map((items) => ({ width: paper.width, height: paper.height, items }))))
      break
    }
    case 'pdf-scan':
      await fs.writeFile(file, await scanPdf(doc, pages))
      break
    case 'png':
      await fs.writeFile(file, drawPage(doc, pages[0]!))
      break
    case 'photo-jpeg':
    case 'photo-heic': {
      let photo = await photograph(drawPage(doc, pages[0]!), d, doc.id)
      // Stored sideways, as a phone held in portrait saves a landscape shot.
      if (d.exifOrientation) photo = sharp(await photo.png().toBuffer()).rotate(270).withMetadata({ orientation: d.exifOrientation })
      const jpeg = await photo.jpeg({ quality: d.jpegQuality ?? 80 }).toBuffer()
      if (doc.format === 'photo-jpeg') {
        await fs.writeFile(file, jpeg)
      } else {
        const tmp = `${file}.tmp.jpg`
        await fs.writeFile(tmp, jpeg)
        await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'heic', tmp, '--out', file])
        await fs.rm(tmp)
      }
      break
    }
  }
  const truth = doc.pages.map((page) => page.flatMap((row) => [...row].sort((a, b) => (a.x ?? 0) - (b.x ?? 0)).map(blockText)))
  return { ...doc, file, truth }
}

export async function renderAll(dir = EVAL_DOCS_DIR): Promise<RenderedDocument[]> {
  await fs.mkdir(dir, { recursive: true })
  const out: RenderedDocument[] = []
  for (const doc of await loadDocuments()) out.push(await renderDocument(doc, dir))
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  for (const doc of await renderAll()) console.log(`${doc.set.padEnd(4)} ${path.relative(PROJECT_ROOT, doc.file)}  ${doc.title}`)
}
