/**
 * A stable id for this computer, for licenses bound to one device. It is a
 * hash of the hardware UUID, so the UUID itself never leaves the machine, and
 * short enough to read out over the phone: XXXX-XXXX-XXXX-XXXX.
 */
import { createHash } from 'node:crypto'
import { run as defaultRun, type Run } from './exec.js'

export const DEVICE_ID = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/

export function deviceIdFrom(hardwareUuid: string): string {
  const hex = createHash('sha256').update(`ofa-device-v1\n${hardwareUuid.trim().toUpperCase()}`).digest('hex').slice(0, 16).toUpperCase()
  return hex.match(/.{4}/g)!.join('-')
}

/** This Mac's device id (from IOPlatformUUID), or undefined where it cannot be read. */
export async function deviceId(run: Run = defaultRun): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined
  const r = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']).catch(() => undefined)
  const uuid = r?.code === 0 ? /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(r.stdout)?.[1] : undefined
  return uuid ? deviceIdFrom(uuid) : undefined
}
