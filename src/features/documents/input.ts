/**
 * What kind of document a file is, judged by its bytes rather than its name,
 * and photos made ready for OCR: turned upright from the camera's EXIF
 * orientation, flattened onto white, capped in size and re-encoded as PNG.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

export type DocumentKind = 'pdf' | 'png' | 'jpeg' | 'heic' | 'bmp' | 'webp' | 'tiff'

export class DocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentError'
  }
}

const startsWith = (bytes: Uint8Array, sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b)
const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))

export function detectKind(bytes: Uint8Array): DocumentKind | undefined {
  // A PDF header may follow a little junk; readers look within the first 1 KB.
  if (ascii(bytes, 0, 1024).includes('%PDF-')) return 'pdf'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(bytes, [0x42, 0x4d])) return 'bmp'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp'
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff'
  if (ascii(bytes, 4, 8) === 'ftyp' && /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(ascii(bytes, 8, 12))) return 'heic'
  return undefined
}

export interface PreparedImage {
  /** PNG, upright, at most `maxSide` pixels on its long side. */
  png: Uint8Array
  width: number
  height: number
  /** Size of the upright original; boxes are reported in its pixels. */
  originalWidth: number
  originalHeight: number
}

export interface PrepareOptions {
  /**
   * Long-side cap in pixels. The OCR detector works on at most 2560 px anyway;
   * a 12 MP photo shrinks here instead of inside the worker.
   */
  maxSide?: number
}

export const DEFAULT_MAX_SIDE = 2560

/** Reads any supported image into an upright PNG for OCR. */
export async function prepareImage(bytes: Uint8Array, kind: DocumentKind, opts: PrepareOptions = {}): Promise<PreparedImage> {
  const input = kind === 'heic' ? await heicToPng(bytes) : bytes
  const { default: sharp } = await import('sharp')
  const maxSide = opts.maxSide ?? DEFAULT_MAX_SIDE
  try {
    const upright = sharp(input, { limitInputPixels: 100_000_000 }).autoOrient()
    const { data, info } = await upright
      .flatten({ background: '#ffffff' })
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true })
    const meta = await sharp(input).metadata()
    // EXIF orientations 5–8 swap width and height.
    const swapped = (meta.orientation ?? 1) >= 5
    return {
      png: new Uint8Array(data),
      width: info.width,
      height: info.height,
      originalWidth: swapped ? meta.height! : meta.width!,
      originalHeight: swapped ? meta.width! : meta.height!
    }
  } catch (err) {
    throw new DocumentError(`Cannot read the ${kind.toUpperCase()} image: ${(err as Error).message}`)
  }
}

/**
 * The prebuilt image library decodes AVIF but not HEIC (HEVC is patent-encumbered),
 * so iPhone photos go through macOS's own converter.
 */
async function heicToPng(bytes: Uint8Array): Promise<Uint8Array> {
  if (process.platform !== 'darwin') {
    throw new DocumentError('HEIC photos can only be read on macOS. Export the photo as JPEG and try again.')
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-heic-'))
  try {
    const src = path.join(dir, 'in.heic')
    const dst = path.join(dir, 'out.png')
    await fs.writeFile(src, bytes)
    await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'png', src, '--out', dst])
    return new Uint8Array(await fs.readFile(dst))
  } catch (err) {
    throw new DocumentError(`Cannot read the HEIC photo: ${(err as Error).message.split('\n')[0]}`)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
