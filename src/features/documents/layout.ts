/**
 * Turns positioned pieces of text (OCR boxes or a PDF's text items) into
 * segments: the runs of text a reader takes as one unit, such as a form field,
 * a heading or a paragraph wrapped over several lines. Each segment is
 * translated on its own, so a sentence must not be cut at a line break, and
 * two fields must not run together.
 */

import { guessLang } from './language.js'

/** [x0, y0, x1, y1], from the top-left corner of the page. */
export type BBox = [number, number, number, number]

export interface TextBox {
  text: string
  bbox: BBox
  /** 0–1 for OCR; absent for a PDF text layer. */
  confidence?: number
}

export interface TextLine {
  text: string
  bbox: BBox
  /** Lowest confidence of the boxes on the line; absent for a text layer. */
  confidence?: number
}

export interface TextBlock {
  text: string
  bbox: BBox
  lines: TextLine[]
  confidence?: number
}

const height = (b: BBox) => b[3] - b[1]
const width = (b: BBox) => b[2] - b[0]
const union = (a: BBox, b: BBox): BBox => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
const minConfidence = (xs: (number | undefined)[]) => {
  const known = xs.filter((x): x is number => x !== undefined)
  return known.length ? Math.min(...known) : undefined
}

/**
 * Boxes on the same row closer than this many line heights are one line; a
 * wider gap separates columns or fields ("Name: …        Weight: …").
 */
const MAX_WORD_GAP = 1.5
/**
 * Lines of one paragraph sit closer than this many line heights apart,
 * centre to centre. OCR boxes are padded, so wrapped lines measured ~0.95
 * and separate rows of a label ~1.6; PDF text boxes are padded alike.
 */
const MAX_LINE_PITCH = 1.35
/** Taller or shorter by more than this is another kind of text (a heading). */
const MAX_HEIGHT_RATIO = 1.35
/** A line this full (of the wider of the two) can wrap onto the next. */
const FULL_LINE = 0.75

/** Groups boxes into lines: a box whose centre falls within a row joins it; a row splits where the gap is wide. */
export function toLines(boxes: TextBox[]): TextLine[] {
  const sorted = boxes
    .filter((b) => b.text.trim() && width(b.bbox) > 0 && height(b.bbox) > 0)
    .sort((a, b) => a.bbox[1] + a.bbox[3] - (b.bbox[1] + b.bbox[3]))
  const rows: TextBox[][] = []
  for (const box of sorted) {
    const center = (box.bbox[1] + box.bbox[3]) / 2
    const row = rows.find((r) => {
      const top = Math.min(...r.map((b) => b.bbox[1]))
      const bottom = Math.max(...r.map((b) => b.bbox[3]))
      // Heights alone vary on a row: "1" is half as tall as "day".
      return center > top && center < bottom
    })
    if (row) row.push(box)
    else rows.push([box])
  }

  const lines: TextLine[] = []
  for (const row of rows) {
    row.sort((a, b) => a.bbox[0] - b.bbox[0])
    let run: TextBox[] = [row[0]!]
    const flush = () => {
      lines.push({
        text: run.map((b) => b.text.trim()).join(' '),
        bbox: run.map((b) => b.bbox).reduce(union),
        confidence: minConfidence(run.map((b) => b.confidence))
      })
    }
    for (const box of row.slice(1)) {
      // Measured from the run's right edge: a short box can sit inside a wide one.
      const right = Math.max(...run.map((b) => b.bbox[2]))
      const lineHeight = Math.max(...run.map((b) => height(b.bbox)), height(box.bbox))
      if (box.bbox[0] - right <= MAX_WORD_GAP * lineHeight) {
        run.push(box)
      } else {
        flush()
        run = [box]
      }
    }
    flush()
  }
  return lines
}

const similarHeight = (a: BBox, b: BBox) => Math.max(height(a), height(b)) / Math.min(height(a), height(b)) <= MAX_HEIGHT_RATIO

/** Ends a sentence or a label, so the next line starts something new. */
const ENDS_UNIT = /[.!?:;]["')\]]*$/
/** Starts a form field ("Date of birth:"), a list item or a numbered step. */
const STARTS_UNIT = /^(?:[•·▪◦*-]\s|\(?\d{1,2}[.)]\s|\p{Lu}[\p{L}'’ ]{0,30}:)/u
const STARTS_LOWER = /^\p{Ll}/u

/** Whether `next` continues the paragraph that `prev` (the block's last line) belongs to. */
function continues(prev: TextLine, next: TextLine): boolean {
  if (!similarHeight(prev.bbox, next.bbox)) return false
  const lineHeight = (height(prev.bbox) + height(next.bbox)) / 2
  const pitch = (next.bbox[1] + next.bbox[3]) / 2 - (prev.bbox[1] + prev.bbox[3]) / 2
  if (pitch > MAX_LINE_PITCH * lineHeight || pitch < 0.5 * lineHeight) return false
  // Left-aligned, or centered on each other (a label).
  const aligned =
    Math.abs(prev.bbox[0] - next.bbox[0]) <= 1.5 * lineHeight ||
    Math.abs((prev.bbox[0] + prev.bbox[2]) / 2 - (next.bbox[0] + next.bbox[2]) / 2) <= 1.5 * lineHeight
  if (!aligned) return false
  if (ENDS_UNIT.test(prev.text) || STARTS_UNIT.test(next.text)) return false
  // A bilingual label alternates languages line by line; OCR often drops the full stop between them.
  if (switchesLanguage(prev.text, next.text)) return false
  return STARTS_LOWER.test(next.text) || width(prev.bbox) >= FULL_LINE * Math.max(width(prev.bbox), width(next.bbox))
}

function switchesLanguage(a: string, b: string): boolean {
  const [ga, gb] = [guessLang(a), guessLang(b)]
  return ga.lang !== gb.lang && ga.margin >= 1.5 && gb.margin >= 1.5
}

/** Joins wrapped lines, undoing a hyphen that split a word ("medi-" + "cine"). */
function joinLines(lines: TextLine[]): string {
  return lines.reduce((text, line) => {
    if (!text) return line.text
    if (/\p{L}-$/u.test(text) && STARTS_LOWER.test(line.text)) return text.slice(0, -1) + line.text
    return `${text} ${line.text}`
  }, '')
}

/** Groups lines into blocks, in reading order: top to bottom, then left to right on a row. */
export function toBlocks(lines: TextLine[]): TextBlock[] {
  const sorted = [...lines].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
  const groups: TextLine[][] = []
  for (const line of sorted) {
    // The nearest open block above whose last line this one continues.
    const group = groups.findLast((g) => continues(g[g.length - 1]!, line))
    if (group) group.push(line)
    else groups.push([line])
  }
  const blocks = groups.map((g) => ({
    text: joinLines(g),
    bbox: g.map((l) => l.bbox).reduce(union),
    lines: g,
    confidence: minConfidence(g.map((l) => l.confidence))
  }))
  return readingOrder(blocks)
}

/** Top to bottom; blocks that start on the same row go left to right. */
export function readingOrder<T extends { bbox: BBox }>(blocks: T[]): T[] {
  return [...blocks].sort((a, b) => {
    const sameRow = Math.abs(a.bbox[1] - b.bbox[1]) < 0.5 * Math.min(height(a.bbox), height(b.bbox), lineHeightOf(a), lineHeightOf(b))
    return sameRow ? a.bbox[0] - b.bbox[0] : a.bbox[1] - b.bbox[1]
  })
}

const lineHeightOf = (b: { bbox: BBox; lines?: TextLine[] }) => (b.lines?.length ? height(b.lines[0]!.bbox) : height(b.bbox))

export const layout = (boxes: TextBox[]): TextBlock[] => toBlocks(toLines(boxes))
