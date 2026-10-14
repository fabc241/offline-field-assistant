import type { LoadRequest, SdkPort, TranscriptSegment } from '../../src/core/qvac.js'

/** Records calls; inference methods return canned values. */
export class FakeSdk implements SdkPort {
  loads: LoadRequest[] = []
  unloads: string[] = []
  reconfigures: { modelId: string; modelType: string; modelConfig: Record<string, unknown> }[] = []
  transcribed: { modelId: string; audio: Float32Array }[] = []
  memory: number | undefined = undefined
  failNext = false
  /** Like the real SDK, derive the id from the request instead of numbering loads. */
  stableIds = false
  segments: TranscriptSegment[] = [{ text: ' Hello.', startMs: 0, endMs: 900 }]

  async loadModel(req: LoadRequest) {
    if (this.failNext) {
      this.failNext = false
      throw new Error('load failed')
    }
    this.loads.push(req)
    return this.stableIds ? `id-${req.modelSrc.split('/').pop()!.replace('.bin', '')}` : `id-${this.loads.length}`
  }
  async reconfigure(req: { modelId: string; modelType: string; modelConfig: Record<string, unknown> }) {
    this.reconfigures.push(req)
  }
  async unloadModel(id: string) {
    this.unloads.push(id)
  }
  async systemMemoryBytes() {
    return this.memory
  }
  async translate() {
    return ''
  }
  async embed() {
    return []
  }
  async transcribe(req: { modelId: string; audio: Float32Array }) {
    this.transcribed.push(req)
    return this.segments
  }
  async synthesize() {
    return { samples: [0, 16384, -16384], sampleRate: 24_000 }
  }
}
