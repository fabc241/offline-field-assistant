/**
 * The page's only way to the services: `window.ofa` (electron/preload.ts),
 * typed by the IPC contract. `call` turns an error envelope into a thrown
 * `CallFailure` whose message is written for the person at the screen.
 */
import type { CallError, Channel, ErrorCode, OfaApi, RequestOf, Responses } from '../../../src/app/contract.js'

declare global {
  interface Window {
    ofa: OfaApi
  }
}

export const ofa = (): OfaApi => window.ofa

export class CallFailure extends Error {
  readonly code: ErrorCode
  readonly error: CallError
  constructor(error: CallError) {
    super(friendlyMessage(error))
    this.name = 'CallFailure'
    this.code = error.code
    this.error = error
  }
}

let calls = 0
export const newCallId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++calls}`

export async function call<C extends Channel>(channel: C, request: RequestOf<C>, opts?: { callId?: string }): Promise<Responses[C]> {
  const answer = await ofa().invoke(channel, request, opts)
  if (!answer.ok) throw new CallFailure(answer.error)
  return answer.value
}

/** What to tell the person, by error code; the service's own message where it is already specific. */
export function friendlyMessage(error: CallError): string {
  switch (error.code) {
    case 'not-licensed':
      return 'Your licence does not include this. The phrasebook and Ask the guide still work. Install a full licence in Settings › Licence.'
    case 'models-missing':
      return 'The speech and translation models are not installed. Install the model pack (Settings › Models).'
    case 'no-pack':
      return 'No content pack is installed. Install one in Settings › Content packs.'
    case 'pack-refused':
      return `This pack was refused: ${error.problem ?? error.message}`
    default:
      return error.message
  }
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
