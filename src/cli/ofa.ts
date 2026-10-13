#!/usr/bin/env -S npx tsx
/**
 * ofa — headless command line for the Offline Field Assistant core.
 *
 *   ofa doctor [--verify] [--load]
 */
import { parseArgs } from 'node:util'
import { loadConfig } from '../core/config.js'
import { shutdown } from '../core/qvac.js'
import { doctor } from './doctor.js'

type Command = (args: string[]) => Promise<boolean>

const commands: Record<string, Command> = {
  async doctor(args) {
    const { values } = parseArgs({
      args,
      options: { verify: { type: 'boolean', default: false }, load: { type: 'boolean', default: false } }
    })
    return doctor(loadConfig(), { verify: values.verify, load: values.load })
  }
}

const [name, ...rest] = process.argv.slice(2)
const command = name ? commands[name] : undefined
if (!command) {
  console.error(`Usage: ofa <${Object.keys(commands).join('|')}> [options]`)
  process.exit(2)
}

let ok = false
try {
  ok = await command(rest)
} catch (err) {
  console.error(`✖ ${(err as Error).message}`)
} finally {
  await shutdown().catch(() => undefined)
}
process.exit(ok ? 0 : 1)
