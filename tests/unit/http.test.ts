import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadHttp } from '../../scripts/http.js'

const body = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))
let dir: string
let server: http.Server
let url: string
/** Bytes to send before going silent on the next request; Infinity sends everything. */
let stallAfter = Infinity
const ranges: (string | undefined)[] = []

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-http-'))
  stallAfter = Infinity
  ranges.length = 0
  server = http.createServer((req, res) => {
    ranges.push(req.headers.range)
    const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0)
    res.writeHead(start ? 206 : 200, { 'content-length': body.length - start })
    const rest = body.subarray(start)
    if (stallAfter === Infinity) return void res.end(rest)
    res.write(rest.subarray(0, stallAfter)) // then never finish
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.bin`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  await fs.rm(dir, { recursive: true, force: true })
})

describe('downloadHttp', () => {
  it('downloads to the target through a .part file', async () => {
    const target = path.join(dir, 'model.bin')
    await downloadHttp(url, target, body.length)
    expect((await fs.readFile(target)).equals(body)).toBe(true)
    await expect(fs.stat(`${target}.part`)).rejects.toThrow()
  })

  it('drops a stalled connection, keeps the partial file and resumes it with a Range request', async () => {
    const target = path.join(dir, 'model.bin')
    stallAfter = 1000
    await expect(downloadHttp(url, target, body.length, 200)).rejects.toThrow(/no data for 0.2 s/)
    expect((await fs.stat(`${target}.part`)).size).toBe(1000)

    stallAfter = Infinity
    await downloadHttp(url, target, body.length, 200)
    expect(ranges).toEqual([undefined, 'bytes=1000-'])
    expect((await fs.readFile(target)).equals(body)).toBe(true)
  })
})
