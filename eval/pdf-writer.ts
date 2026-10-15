/**
 * A minimal PDF writer for test and eval documents: text in the standard
 * fonts (a real text layer) and JPEG images (a scanned page, no text layer).
 * Coordinates are PDF points from the top-left corner, like an image.
 */

export type StandardFont = 'Helvetica' | 'Helvetica-Bold' | 'Times-Roman' | 'Times-Bold' | 'Courier' | 'Courier-Bold'

export interface PdfText {
  kind: 'text'
  /** Left edge and baseline, in points from the top-left corner. */
  x: number
  y: number
  size: number
  font: StandardFont
  /** Latin-1 only (the standard fonts' WinAnsi encoding). */
  text: string
}

export interface PdfImage {
  kind: 'image'
  jpeg: Uint8Array
  pixelWidth: number
  pixelHeight: number
  /** Placement, in points from the top-left corner. */
  x: number
  y: number
  width: number
  height: number
}

export interface PdfPage {
  width: number
  height: number
  items: (PdfText | PdfImage)[]
}

const FONTS: StandardFont[] = ['Helvetica', 'Helvetica-Bold', 'Times-Roman', 'Times-Bold', 'Courier', 'Courier-Bold']

const escapeText = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)

export function writePdf(pages: PdfPage[]): Uint8Array {
  const objects: (string | Uint8Array)[][] = []
  const add = (...parts: (string | Uint8Array)[]) => objects.push(parts) // object n is objects[n - 1]

  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('') // pages tree, filled in below
  const fontRefs = FONTS.map((font) => {
    add(`<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`)
    return objects.length
  })
  const fontDict = FONTS.map((f, i) => `/F${i} ${fontRefs[i]} 0 R`).join(' ')

  const pageRefs: number[] = []
  for (const page of pages) {
    const images: string[] = []
    const ops: string[] = []
    for (const item of page.items) {
      if (item.kind === 'text') {
        if (/[^\x20-\xff]/.test(item.text)) throw new Error(`Not Latin-1: ${item.text}`)
        const f = FONTS.indexOf(item.font)
        ops.push(`BT /F${f} ${item.size} Tf ${item.x} ${page.height - item.y} Td (${escapeText(item.text)}) Tj ET`)
      } else {
        add(
          `<< /Type /XObject /Subtype /Image /Width ${item.pixelWidth} /Height ${item.pixelHeight} /ColorSpace /DeviceRGB ` +
            `/BitsPerComponent 8 /Filter /DCTDecode /Length ${item.jpeg.length} >>\nstream\n`,
          item.jpeg,
          '\nendstream'
        )
        const name = `Im${images.length}`
        images.push(`/${name} ${objects.length} 0 R`)
        ops.push(`q ${item.width} 0 0 ${item.height} ${item.x} ${page.height - item.y - item.height} cm /${name} Do Q`)
      }
    }
    const content = ops.join('\n')
    add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`)
    const contentRef = objects.length
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Contents ${contentRef} 0 R ` +
        `/Resources << /Font << ${fontDict} >> /XObject << ${images.join(' ')} >> >> >>`
    )
    pageRefs.push(objects.length)
  }
  objects[1] = [`<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pages.length} >>`]

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  let offset = chunks[0]!.length
  const offsets: number[] = []
  for (const [i, parts] of objects.entries()) {
    offsets.push(offset)
    const body = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      ...parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
      Buffer.from('\nendobj\n', 'latin1')
    ])
    chunks.push(body)
    offset += body.length
  }
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`
  chunks.push(Buffer.from(xref, 'latin1'))
  return new Uint8Array(Buffer.concat(chunks))
}
