/**
 * One entry point for every IPC call: checks the channel and the request
 * against the contract, runs the service, and turns any outcome into an
 * envelope. Electron-free, so unit tests drive it directly.
 */
import { REQUESTS, isChannel, type Envelope } from './contract.js'
import { recordFailure, toCallError, type AppServices, type CallContext } from './services.js'
import type { Session } from '../features/platform/session.js'

export type Dispatch = (channel: unknown, request: unknown, ctx?: CallContext) => Promise<Envelope<unknown>>

export function createDispatcher(services: AppServices, session: Session): Dispatch {
  return async (channel, request, ctx = {}) => {
    if (!isChannel(channel)) return { ok: false, error: { code: 'unknown-channel', message: `No channel ${JSON.stringify(channel)}` } }
    const parsed = REQUESTS[channel].safeParse(request ?? {})
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ')
      return { ok: false, error: { code: 'bad-request', message } }
    }
    try {
      // The schema for `channel` produced `parsed.data`, so it is that handler's request.
      const handler = services.handlers[channel] as (req: unknown, ctx: CallContext) => Promise<unknown>
      return { ok: true, value: await handler(parsed.data, ctx) }
    } catch (err) {
      await recordFailure(session, channel, err)
      return { ok: false, error: toCallError(err) }
    }
  }
}
