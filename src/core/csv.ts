/** Minimal RFC 4180 CSV for content packs, eval datasets and outputs. */

export interface CsvTable {
  header: string[]
  /** Data rows keyed by header; blank lines are skipped. */
  rows: Record<string, string>[]
  /** Number of fields in each data row as written, to catch rows that are too long or too short. */
  widths: number[]
}

export function parseCsv(text: string): Record<string, string>[] {
  return parseCsvTable(text).rows
}

/** Like parseCsv, but keeps the header as written (spreadsheet exports start with a BOM, which is dropped). */
export function parseCsvTable(text: string): CsvTable {
  if (text.startsWith('\uFEFF')) text = text.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') {
        quoted = false
      } else {
        field += c
      }
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field || row.length) rows.push([...row, field])
  const [header, ...body] = rows.filter((r) => r.some((f) => f !== ''))
  if (!header) return { header: [], rows: [], widths: [] }
  return {
    header,
    rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))),
    widths: body.map((r) => r.length)
  }
}

export function toCsv(rows: Record<string, string | number>[]): string {
  if (rows.length === 0) return ''
  const header = Object.keys(rows[0]!)
  const cell = (v: string | number) => {
    const s = String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [header.join(','), ...rows.map((r) => header.map((h) => cell(r[h] ?? '')).join(','))].join('\n') + '\n'
}
