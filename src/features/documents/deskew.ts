/**
 * Straightens a photographed or scanned page before OCR. The engine reports
 * axis-aligned boxes, so on a page tilted by 2° the two ends of a long line
 * land at different heights and the line falls apart into pieces that sort
 * into the wrong order. The tilt is found from the ink itself: rows of text
 * line up sharpest in a horizontal projection when the angle is right.
 */
import type { BBox } from './layout.js'

/** Tilts searched, in degrees either way. Beyond this a photo needs retaking, not straightening. */
const MAX_ANGLE = 8
/** Smaller tilts are left alone: the boxes barely change and rotating blurs the text. */
export const MIN_DESKEW_ANGLE = 0.3
/** Width the angle is estimated at; text lines stay a few pixels tall. */
const WORK_WIDTH = 1000

export interface Straightened {
  png: Uint8Array
  width: number
  height: number
  /** Clockwise tilt found in the input, degrees; 0 when it was left alone. */
  angle: number
  /** Maps a box in the straightened image back to the input image. */
  toInput(bbox: BBox): BBox
}

/**
 * Clockwise tilt of the text, in degrees: the angle whose projection profile
 * (ink per row along that slope) has the sharpest rows.
 */
export async function estimateSkew(png: Uint8Array): Promise<number> {
  const { default: sharp } = await import('sharp')
  const gray = sharp(png).grayscale().resize({ width: WORK_WIDTH, withoutEnlargement: true })
  const { data, info } = await gray.clone().raw().toBuffer({ resolveWithObject: true })
  // Ink is darker than its surroundings; a dark table around the page is not.
  const { data: local } = await gray.clone().blur(6).raw().toBuffer({ resolveWithObject: true })
  const xs: number[] = []
  const ys: number[] = []
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = y * info.width + x
      if (data[i]! < local[i]! - 25) {
        xs.push(x - info.width / 2)
        ys.push(y)
      }
    }
  }
  if (xs.length < 200) return 0

  const sharpness = (deg: number) => {
    const t = Math.tan((deg * Math.PI) / 180)
    const offset = Math.ceil(Math.abs(t) * info.width) + 1
    const bins = new Float64Array(info.height + 2 * offset)
    for (let i = 0; i < xs.length; i++) bins[Math.round(ys[i]! - xs[i]! * t) + offset]! += 1
    let s = 0
    for (let i = 1; i < bins.length; i++) s += (bins[i]! - bins[i - 1]!) ** 2
    return s
  }
  const best = (from: number, to: number, step: number) => {
    let angle = 0
    let score = -1
    for (let a = from; a <= to + 1e-9; a += step) {
      const s = sharpness(a)
      if (s > score) [angle, score] = [a, s]
    }
    return angle
  }
  const coarse = best(-MAX_ANGLE, MAX_ANGLE, 0.5)
  return Math.round(best(coarse - 0.5, coarse + 0.5, 0.05) * 100) / 100
}

/** The page turned upright, or the input unchanged when the tilt is under MIN_DESKEW_ANGLE. */
export async function straighten(png: Uint8Array, width: number, height: number): Promise<Straightened> {
  const angle = await estimateSkew(png)
  if (Math.abs(angle) < MIN_DESKEW_ANGLE) return { png, width, height, angle: 0, toInput: (b) => b }
  const { default: sharp } = await import('sharp')
  const { data, info } = await sharp(png).rotate(-angle, { background: '#ffffff' }).png().toBuffer({ resolveWithObject: true })
  // sharp rotates about the centre and grows the canvas to fit.
  const rad = (angle * Math.PI) / 180
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)]
  const back = (x: number, y: number): [number, number] => {
    const dx = x - info.width / 2
    const dy = y - info.height / 2
    return [width / 2 + dx * cos - dy * sin, height / 2 + dx * sin + dy * cos]
  }
  return {
    png: new Uint8Array(data),
    width: info.width,
    height: info.height,
    angle,
    toInput([x0, y0, x1, y1]) {
      const corners = [back(x0, y0), back(x1, y0), back(x0, y1), back(x1, y1)]
      const cx = corners.map((c) => c[0])
      const cy = corners.map((c) => c[1])
      return [Math.max(0, Math.min(...cx)), Math.max(0, Math.min(...cy)), Math.min(width, Math.max(...cx)), Math.min(height, Math.max(...cy))]
    }
  }
}
