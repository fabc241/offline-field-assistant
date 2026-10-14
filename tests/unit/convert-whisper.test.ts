import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { convertHfWhisper, hfTensorName } from '../../scripts/convert-whisper.js'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofa-conv-'))
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

const i32 = (...xs: number[]) => Buffer.from(new Int32Array(xs).buffer)

/** A whisper.cpp file: header, then tensors given as [name, ggml dims, type, values]. */
function ggml(tensors: [string, number[], 0 | 1, number[]][]): Buffer {
  const header = [
    i32(0x67676d6c),
    i32(4, 1, 2, 1, 1, 1, 2, 1, 1, 2, 1), // hparams (n_vocab 4)
    i32(2, 3),
    Buffer.from(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]).buffer), // mel filters
    i32(2),
    i32(1), Buffer.from('a'),
    i32(2), Buffer.from('bc')
  ]
  const body = tensors.flatMap(([name, dims, type, values]) => [
    i32(dims.length, Buffer.byteLength(name), type, ...dims),
    Buffer.from(name),
    Buffer.from((type === 0 ? new Float32Array(values) : Float16Array.from(values)).buffer)
  ])
  return Buffer.concat([...header, ...body])
}

function safetensors(tensors: Record<string, [number[], number[]]>): Buffer {
  let offset = 0
  const meta: Record<string, unknown> = { __metadata__: { format: 'pt' } }
  const data: Buffer[] = []
  for (const [name, [shape, values]] of Object.entries(tensors)) {
    const bytes = Buffer.from(new Float32Array(values).buffer)
    meta[name] = { dtype: 'F32', shape, data_offsets: [offset, offset + bytes.length] }
    data.push(bytes)
    offset += bytes.length
  }
  const json = Buffer.from(JSON.stringify(meta))
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(json.length))
  return Buffer.concat([len, json, ...data])
}

describe('hfTensorName', () => {
  it.each([
    ['encoder.conv1.weight', 'model.encoder.conv1.weight'],
    ['encoder.positional_embedding', 'model.encoder.embed_positions.weight'],
    ['encoder.blocks.31.attn.query.weight', 'model.encoder.layers.31.self_attn.q_proj.weight'],
    ['encoder.blocks.0.attn.out.bias', 'model.encoder.layers.0.self_attn.out_proj.bias'],
    ['encoder.blocks.0.attn_ln.weight', 'model.encoder.layers.0.self_attn_layer_norm.weight'],
    ['encoder.blocks.0.mlp.0.weight', 'model.encoder.layers.0.fc1.weight'],
    ['encoder.blocks.0.mlp.2.bias', 'model.encoder.layers.0.fc2.bias'],
    ['encoder.blocks.0.mlp_ln.bias', 'model.encoder.layers.0.final_layer_norm.bias'],
    ['encoder.ln_post.weight', 'model.encoder.layer_norm.weight'],
    ['decoder.token_embedding.weight', 'model.decoder.embed_tokens.weight'],
    ['decoder.blocks.3.cross_attn.key.weight', 'model.decoder.layers.3.encoder_attn.k_proj.weight'],
    ['decoder.blocks.3.cross_attn_ln.bias', 'model.decoder.layers.3.encoder_attn_layer_norm.bias'],
    ['decoder.ln.bias', 'model.decoder.layer_norm.bias']
  ])('%s → %s', (ggmlName, hf) => expect(hfTensorName(ggmlName)).toBe(hf))
})

describe('convertHfWhisper', () => {
  it('keeps the template header, converts types and cuts appended vocabulary rows', async () => {
    const template = ggml([
      ['decoder.token_embedding.weight', [2, 4], 1, Array(8).fill(0)],
      ['encoder.conv1.bias', [1, 2], 0, [0, 0]],
      ['encoder.blocks.0.attn.query.bias', [2], 0, [0, 0]]
    ])
    await fs.writeFile(path.join(dir, 'base.bin'), template)
    await fs.writeFile(
      path.join(dir, 'ft.safetensors'),
      safetensors({
        'model.decoder.embed_tokens.weight': [[5, 2], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]], // one appended row
        'model.encoder.conv1.bias': [[2], [0.5, -0.5]],
        'model.encoder.layers.0.self_attn.q_proj.bias': [[2], [0.25, 0.125]],
        'proj_out.weight': [[5, 2], Array(10).fill(1)]
      })
    )
    const out = path.join(dir, 'out.bin')
    const res = await convertHfWhisper({ template: path.join(dir, 'base.bin'), safetensors: path.join(dir, 'ft.safetensors'), out })
    expect(res).toEqual({ tensors: 3, truncated: ['decoder.token_embedding.weight 5→4'], unused: ['proj_out.weight'] })

    const expected = ggml([
      ['decoder.token_embedding.weight', [2, 4], 1, [1, 2, 3, 4, 5, 6, 7, 8]],
      ['encoder.conv1.bias', [1, 2], 0, [0.5, -0.5]],
      ['encoder.blocks.0.attn.query.bias', [2], 0, [0.25, 0.125]]
    ])
    expect((await fs.readFile(out)).equals(expected)).toBe(true)
  })

  it('refuses a fine-tune whose shapes do not fit the template', async () => {
    await fs.writeFile(path.join(dir, 'base.bin'), ggml([['encoder.conv1.bias', [1, 2], 0, [0, 0]]]))
    await fs.writeFile(path.join(dir, 'ft.safetensors'), safetensors({ 'model.encoder.conv1.bias': [[3], [1, 2, 3]] }))
    await expect(
      convertHfWhisper({ template: path.join(dir, 'base.bin'), safetensors: path.join(dir, 'ft.safetensors'), out: path.join(dir, 'o.bin') })
    ).rejects.toThrow(/does not fit/)
  })

  it('refuses a fine-tune that is missing a tensor', async () => {
    await fs.writeFile(path.join(dir, 'base.bin'), ggml([['decoder.ln.bias', [2], 0, [0, 0]]]))
    await fs.writeFile(path.join(dir, 'ft.safetensors'), safetensors({}))
    await expect(
      convertHfWhisper({ template: path.join(dir, 'base.bin'), safetensors: path.join(dir, 'ft.safetensors'), out: path.join(dir, 'o.bin') })
    ).rejects.toThrow(/no tensor "model.decoder.layer_norm.bias"/)
  })
})
