/**
 * Converts a Hugging Face Whisper fine-tune (safetensors) into whisper.cpp's
 * ggml format, using a stock ggml file of the same architecture as the
 * template: its header (hyperparameters, mel filters, vocabulary) is copied
 * byte for byte, and every tensor is replaced by the fine-tune's weights in
 * the template's type (f32 or f16) and layout. No Python, no torch.
 *
 * Fine-tunes that appended tokens to the vocabulary (Paza adds five language
 * tokens) are cut back to the template's vocabulary size. whisper.cpp derives
 * its special-token ids from the vocabulary size, so a larger vocabulary would
 * shift them; the appended rows are only used by those new language tokens.
 */
import fs from 'node:fs/promises'

const GGML_MAGIC = 0x67676d6c
const GGML_F32 = 0
const GGML_F16 = 1
const HPARAMS = 11

interface SafeTensor {
  dtype: string
  shape: number[]
  data_offsets: [number, number]
}

/** whisper.cpp (openai) tensor name → Hugging Face transformers name. */
export function hfTensorName(name: string): string {
  const fixed: Record<string, string> = {
    'encoder.positional_embedding': 'model.encoder.embed_positions.weight',
    'decoder.positional_embedding': 'model.decoder.embed_positions.weight',
    'decoder.token_embedding.weight': 'model.decoder.embed_tokens.weight'
  }
  if (fixed[name]) return fixed[name]
  const parts: [RegExp, string][] = [
    [/^(encoder|decoder)\.conv(\d)\./, 'model.$1.conv$2.'],
    [/^encoder\.ln_post\./, 'model.encoder.layer_norm.'],
    [/^decoder\.ln\./, 'model.decoder.layer_norm.'],
    [/^(encoder|decoder)\.blocks\.(\d+)\./, 'model.$1.layers.$2.'],
    [/\.cross_attn_ln\./, '.encoder_attn_layer_norm.'],
    [/\.cross_attn\./, '.encoder_attn.'],
    [/\.attn_ln\./, '.self_attn_layer_norm.'],
    [/\.attn\./, '.self_attn.'],
    [/\.query\./, '.q_proj.'],
    [/\.key\./, '.k_proj.'],
    [/\.value\./, '.v_proj.'],
    [/\.out\./, '.out_proj.'],
    [/\.mlp_ln\./, '.final_layer_norm.'],
    [/\.mlp\.0\./, '.fc1.'],
    [/\.mlp\.2\./, '.fc2.']
  ]
  return parts.reduce((n, [re, to]) => n.replace(re, to), name)
}

export interface ConvertResult {
  tensors: number
  /** Tensors cut to the template's size (appended vocabulary rows). */
  truncated: string[]
  /** Fine-tune tensors the template has no slot for (e.g. a tied output projection). */
  unused: string[]
}

export async function convertHfWhisper(opts: { template: string; safetensors: string; out: string }): Promise<ConvertResult> {
  const tpl = await fs.open(opts.template, 'r')
  const src = await fs.open(opts.safetensors, 'r')
  const out = await fs.open(opts.out, 'w')
  try {
    const tplSize = (await tpl.stat()).size
    let pos = 0
    const read = async (n: number) => {
      const b = Buffer.alloc(n)
      const { bytesRead } = await tpl.read(b, 0, n, pos)
      if (bytesRead !== n) throw new Error(`${opts.template}: truncated at byte ${pos}`)
      pos += n
      return b
    }
    const i32 = async () => (await read(4)).readInt32LE(0)

    // Header: magic, hyperparameters, mel filters, vocabulary.
    if ((await read(4)).readUInt32LE(0) !== GGML_MAGIC) throw new Error(`${opts.template} is not a whisper.cpp ggml file`)
    pos += HPARAMS * 4
    const nMel = await i32()
    const nFft = await i32()
    pos += nMel * nFft * 4
    const nVocab = await i32()
    for (let i = 0; i < nVocab; i++) pos += 4 + (await read(4)).readUInt32LE(0)
    const headerSize = pos
    const header = Buffer.alloc(headerSize)
    await tpl.read(header, 0, headerSize, 0)
    await out.write(header)

    const lenBuf = Buffer.alloc(8)
    await src.read(lenBuf, 0, 8, 0)
    const jsonLen = Number(lenBuf.readBigUInt64LE(0))
    const jsonBuf = Buffer.alloc(jsonLen)
    await src.read(jsonBuf, 0, jsonLen, 8)
    const table = JSON.parse(jsonBuf.toString('utf8')) as Record<string, SafeTensor>
    const dataStart = 8 + jsonLen
    const used = new Set<string>()
    const truncated: string[] = []
    let tensors = 0

    let outPos = headerSize
    while (pos < tplSize) {
      const nDims = await i32()
      const nameLen = await i32()
      const ttype = await i32()
      const dims: number[] = []
      for (let i = 0; i < nDims; i++) dims.push(await i32())
      const nameBytes = await read(nameLen)
      const name = nameBytes.toString('utf8')
      const count = dims.reduce((a, b) => a * b, 1)
      if (ttype !== GGML_F32 && ttype !== GGML_F16) throw new Error(`${name}: template type ${ttype} is not f32/f16`)
      pos += count * (ttype === GGML_F32 ? 4 : 2)

      const hf = hfTensorName(name)
      const t = table[hf]
      if (!t) throw new Error(`${name}: no tensor "${hf}" in ${opts.safetensors}`)
      if (t.dtype !== 'F32') throw new Error(`${hf}: dtype ${t.dtype}, expected F32`)
      const srcCount = t.shape.reduce((a, b) => a * b, 1)
      // ggml lists dims innermost first; the leading (outermost) numpy dim may only shrink.
      const inner = dims.slice(0, -1).reduce((a, b) => a * b, 1)
      const srcInner = t.shape.length > 1 ? t.shape.slice(1).reduce((a, b) => a * b, 1) : srcCount
      if (srcCount !== count && !(srcCount > count && srcInner === inner && dims.length === t.shape.length)) {
        throw new Error(`${name}: shape [${t.shape}] does not fit template dims [${dims}]`)
      }
      if (srcCount !== count) truncated.push(`${name} ${t.shape[0]}→${dims.at(-1)}`)
      used.add(hf)

      const f32 = new Float32Array(count)
      const { bytesRead } = await src.read(new Uint8Array(f32.buffer), 0, count * 4, dataStart + t.data_offsets[0])
      if (bytesRead !== count * 4) throw new Error(`${hf}: ${opts.safetensors} is truncated`)
      const data = ttype === GGML_F32 ? f32 : Float16Array.from(f32)
      if (ttype === GGML_F16 && (data as Float16Array).some((v) => !Number.isFinite(v))) {
        throw new Error(`${name}: values overflow float16`)
      }

      const meta = Buffer.alloc(12 + 4 * nDims)
      meta.writeInt32LE(nDims, 0)
      meta.writeInt32LE(nameLen, 4)
      meta.writeInt32LE(ttype, 8)
      dims.forEach((d, i) => meta.writeInt32LE(d, 12 + 4 * i))
      for (const chunk of [meta, nameBytes, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)]) {
        await out.write(chunk, 0, chunk.byteLength, outPos)
        outPos += chunk.byteLength
      }
      tensors++
    }
    return { tensors, truncated, unused: Object.keys(table).filter((k) => k !== '__metadata__' && !used.has(k)) }
  } finally {
    await Promise.all([tpl.close(), src.close(), out.close()])
  }
}
