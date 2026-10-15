/**
 * The .ofapack container: a ZIP file in one exact layout. Entries are stored
 * uncompressed, with fixed timestamps and attributes and no extra fields, so
 * every byte of the file is either a fixed value, a length or offset the
 * reader cross-checks, a CRC, or file content covered by the manifest's
 * sha256. The reader accepts only that layout: flip any one byte and the pack
 * is rejected. Any unzip tool can still open a pack for inspection.
 *
 * Content is small (JSON and short recordings that do not compress well), so
 * storing beats deflate, and there is nothing to decompress on the device.
 */
import { crc32 } from 'node:zlib'

export interface ArchiveEntry {
  /** Relative path with forward slashes, e.g. "audio/greet-001.sw.wav". */
  name: string
  data: Uint8Array
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveError'
  }
}

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const END_SIG = 0x06054b50
const LOCAL_SIZE = 30
const CENTRAL_SIZE = 46
const END_SIZE = 22

const VERSION_NEEDED = 10 // 1.0: stored entries
const MADE_BY = (3 << 8) | 30 // Unix, spec 3.0
const FLAGS = 0x0800 // names are UTF-8
const STORED = 0
const DOS_TIME = 0
const DOS_DATE = (1 << 5) | 1 // 1980-01-01
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0 // regular file, rw-r--r--

const MAX_ENTRIES = 10_000
const MAX_NAME_BYTES = 255
const MAX_U32 = 0xffffffff

const utf8 = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** Throws unless `name` is a safe relative path: no "..", no absolute paths, no directories. */
export function assertEntryName(name: string): void {
  const problem =
    name === ''
      ? 'is empty'
      : utf8.encode(name).length > MAX_NAME_BYTES
        ? `is longer than ${MAX_NAME_BYTES} bytes`
        : /[\u0000-\u001f\u007f\\:]/.test(name)
          ? 'contains a control character, backslash or colon'
          : name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
            ? 'is not a plain relative path'
            : name.normalize('NFC') !== name
              ? 'is not NFC-normalized'
              : undefined
  if (problem) throw new ArchiveError(`Entry name ${JSON.stringify(name)} ${problem}`)
}

export function writeArchive(entries: ArchiveEntry[]): Buffer {
  if (entries.length > MAX_ENTRIES) throw new ArchiveError(`More than ${MAX_ENTRIES} entries`)
  const seen = new Set<string>()
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    assertEntryName(name)
    if (seen.has(name)) throw new ArchiveError(`Duplicate entry ${name}`)
    seen.add(name)
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(LOCAL_SIZE)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(VERSION_NEEDED, 4)
    local.writeUInt16LE(FLAGS, 6)
    local.writeUInt16LE(STORED, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, Buffer.from(data.buffer, data.byteOffset, data.byteLength))

    const central = Buffer.alloc(CENTRAL_SIZE)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(MADE_BY, 4)
    central.writeUInt16LE(VERSION_NEEDED, 6)
    central.writeUInt16LE(FLAGS, 8)
    central.writeUInt16LE(STORED, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    // extra length, comment length, disk number, internal attributes: 0
    central.writeUInt32LE(EXTERNAL_ATTRS, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += LOCAL_SIZE + nameBytes.length + data.length
    if (offset > MAX_U32) throw new ArchiveError('Archive is larger than 4 GB')
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0)
  const end = Buffer.alloc(END_SIZE)
  end.writeUInt32LE(END_SIG, 0)
  // disk numbers: 0
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  // comment length: 0
  return Buffer.concat([...locals, ...centrals, end])
}

/** Parses an archive written by writeArchive; anything else throws ArchiveError. */
export function readArchive(input: Uint8Array): ArchiveEntry[] {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const fail = (what: string, at: number): never => {
    throw new ArchiveError(`Not a valid pack archive: ${what} at byte ${at}`)
  }
  const expect = (actual: number, expected: number, what: string, at: number) => {
    if (actual !== expected) fail(what, at)
  }
  const need = (at: number, size: number) => {
    if (at + size > buf.length) fail('truncated', at)
  }

  interface Local {
    name: string
    nameBytes: Buffer
    offset: number
    crc: number
    data: Buffer
  }
  const locals: Local[] = []
  let pos = 0
  while (pos + 4 <= buf.length && buf.readUInt32LE(pos) === LOCAL_SIG) {
    if (locals.length >= MAX_ENTRIES) fail('too many entries', pos)
    need(pos, LOCAL_SIZE)
    expect(buf.readUInt16LE(pos + 4), VERSION_NEEDED, 'unexpected version', pos + 4)
    expect(buf.readUInt16LE(pos + 6), FLAGS, 'unexpected flags', pos + 6)
    expect(buf.readUInt16LE(pos + 8), STORED, 'compressed entry', pos + 8)
    expect(buf.readUInt16LE(pos + 10), DOS_TIME, 'unexpected timestamp', pos + 10)
    expect(buf.readUInt16LE(pos + 12), DOS_DATE, 'unexpected timestamp', pos + 12)
    const crc = buf.readUInt32LE(pos + 14)
    const size = buf.readUInt32LE(pos + 18)
    expect(buf.readUInt32LE(pos + 22), size, 'size mismatch', pos + 22)
    const nameLength = buf.readUInt16LE(pos + 26)
    expect(buf.readUInt16LE(pos + 28), 0, 'extra field', pos + 28)
    need(pos + LOCAL_SIZE, nameLength + size)
    const nameBytes = buf.subarray(pos + LOCAL_SIZE, pos + LOCAL_SIZE + nameLength)
    const name = decodeName(nameBytes, pos + LOCAL_SIZE)
    const data = buf.subarray(pos + LOCAL_SIZE + nameLength, pos + LOCAL_SIZE + nameLength + size)
    if (crc32(data) !== crc) fail(`CRC mismatch for ${name}`, pos + 14)
    if (locals.some((l) => l.name === name)) fail(`duplicate entry ${name}`, pos)
    locals.push({ name, nameBytes, offset: pos, crc, data })
    pos += LOCAL_SIZE + nameLength + size
  }

  const centralOffset = pos
  for (const local of locals) {
    need(pos, CENTRAL_SIZE)
    expect(buf.readUInt32LE(pos), CENTRAL_SIG, 'expected a central directory entry', pos)
    expect(buf.readUInt16LE(pos + 4), MADE_BY, 'unexpected creator', pos + 4)
    expect(buf.readUInt16LE(pos + 6), VERSION_NEEDED, 'unexpected version', pos + 6)
    expect(buf.readUInt16LE(pos + 8), FLAGS, 'unexpected flags', pos + 8)
    expect(buf.readUInt16LE(pos + 10), STORED, 'compressed entry', pos + 10)
    expect(buf.readUInt16LE(pos + 12), DOS_TIME, 'unexpected timestamp', pos + 12)
    expect(buf.readUInt16LE(pos + 14), DOS_DATE, 'unexpected timestamp', pos + 14)
    expect(buf.readUInt32LE(pos + 16), local.crc, 'CRC differs from the local header', pos + 16)
    expect(buf.readUInt32LE(pos + 20), local.data.length, 'size differs from the local header', pos + 20)
    expect(buf.readUInt32LE(pos + 24), local.data.length, 'size differs from the local header', pos + 24)
    expect(buf.readUInt16LE(pos + 28), local.nameBytes.length, 'name differs from the local header', pos + 28)
    expect(buf.readUInt16LE(pos + 30), 0, 'extra field', pos + 30)
    expect(buf.readUInt16LE(pos + 32), 0, 'entry comment', pos + 32)
    expect(buf.readUInt16LE(pos + 34), 0, 'multi-disk archive', pos + 34)
    expect(buf.readUInt16LE(pos + 36), 0, 'unexpected attributes', pos + 36)
    expect(buf.readUInt32LE(pos + 38), EXTERNAL_ATTRS, 'unexpected attributes', pos + 38)
    expect(buf.readUInt32LE(pos + 42), local.offset, 'offset differs from the local header', pos + 42)
    need(pos + CENTRAL_SIZE, local.nameBytes.length)
    if (!buf.subarray(pos + CENTRAL_SIZE, pos + CENTRAL_SIZE + local.nameBytes.length).equals(local.nameBytes)) {
      fail('name differs from the local header', pos + CENTRAL_SIZE)
    }
    pos += CENTRAL_SIZE + local.nameBytes.length
  }

  need(pos, END_SIZE)
  expect(buf.readUInt32LE(pos), END_SIG, 'expected the end of the central directory', pos)
  expect(buf.readUInt16LE(pos + 4), 0, 'multi-disk archive', pos + 4)
  expect(buf.readUInt16LE(pos + 6), 0, 'multi-disk archive', pos + 6)
  expect(buf.readUInt16LE(pos + 8), locals.length, 'entry count mismatch', pos + 8)
  expect(buf.readUInt16LE(pos + 10), locals.length, 'entry count mismatch', pos + 10)
  expect(buf.readUInt32LE(pos + 12), pos - centralOffset, 'central directory size mismatch', pos + 12)
  expect(buf.readUInt32LE(pos + 16), centralOffset, 'central directory offset mismatch', pos + 16)
  expect(buf.readUInt16LE(pos + 20), 0, 'archive comment', pos + 20)
  if (pos + END_SIZE !== buf.length) fail('trailing data', pos + END_SIZE)

  return locals.map(({ name, data }) => ({ name, data }))
}

function decodeName(bytes: Buffer, at: number): string {
  let name: string
  try {
    name = strictUtf8.decode(bytes)
  } catch {
    throw new ArchiveError(`Not a valid pack archive: entry name is not UTF-8 at byte ${at}`)
  }
  assertEntryName(name)
  return name
}
