/**
 * The ofa commands, callable in-process: by the `ofa` script (Node, dev) and
 * by the packaged app (`offline-field-assistant ofa doctor`), which runs them
 * inside Electron so a clinic Mac needs no Node install.
 *
 * Every command starts by checking the license (see features/platform/license.ts)
 * and records what it did, metadata only, in the encrypted activity log.
 */
import { parseArgs } from 'node:util'
import { loadConfig, type AppConfig } from '../core/config.js'
import { shutdown } from '../core/qvac.js'
import { errorKind, type ActivityFeature } from '../features/platform/activity.js'
import type { SecretVault } from '../features/platform/keys.js'
import { converseCommand } from './converse.js'
import { docCommand } from './doc.js'
import { doctor } from './doctor.js'
import { guideCommand } from './guide.js'
import { licenseCommand } from './license.js'
import { logsCommand } from './logs.js'
import { modelsCommand } from './models.js'
import { packCommand } from './pack.js'
import { phraseCommand } from './phrase.js'
import { openSession, type Session } from './session.js'
import { speakCommand } from './speak.js'
import { sttCommand } from './stt.js'
import { translateCommand } from './translate.js'

type Command = (config: AppConfig, args: string[], session: Session) => Promise<boolean>

const commands: Record<string, Command> = {
  async doctor(config, args, session) {
    const { values } = parseArgs({
      args,
      options: { verify: { type: 'boolean', default: false }, load: { type: 'boolean', default: false } }
    })
    return doctor(config, session, { verify: values.verify, load: values.load })
  },
  translate: translateCommand,
  stt: sttCommand,
  speak: speakCommand,
  converse: converseCommand,
  pack: packCommand,
  models: modelsCommand,
  phrase: phraseCommand,
  guide: guideCommand,
  doc: docCommand,
  license: licenseCommand,
  logs: logsCommand
}

/** The feature an error in each command is recorded under. */
const FEATURE: Record<string, ActivityFeature> = {
  translate: 'translate',
  stt: 'speech',
  speak: 'read-aloud',
  converse: 'conversation',
  pack: 'packs',
  models: 'models',
  phrase: 'phrasebook',
  guide: 'guide',
  doc: 'documents',
  license: 'license',
  logs: 'logs'
}

const WITH_SUBCOMMANDS = new Set(['pack', 'models', 'phrase', 'doc', 'license', 'logs'])

export interface RunOptions {
  env?: NodeJS.ProcessEnv
  /** Where the log key lives; default the macOS Keychain. The packaged app passes its safeStorage vault. */
  vault?: SecretVault | null
}

/** Runs one ofa command; resolves to the process exit code. */
export async function runOfa(argv: string[], opts: RunOptions = {}): Promise<number> {
  const [name, ...rest] = argv
  const command = name ? commands[name] : undefined
  if (!command) {
    console.error(`Usage: ofa <${Object.keys(commands).join('|')}> [options]`)
    return 2
  }

  let ok = false
  let session: Session | undefined
  try {
    const config = loadConfig(opts.env)
    session = await openSession(config, opts.vault !== undefined ? { vault: opts.vault } : {})
    ok = await command(config, rest, session)
  } catch (err) {
    console.error(`✖ ${(err as Error).message}`)
    const feature = FEATURE[name!]
    // Only commands with subcommands: elsewhere the first argument can be the user's text.
    const action = WITH_SUBCOMMANDS.has(name!) && /^[a-z-]{1,20}$/.test(rest[0] ?? '') ? rest[0]! : name!
    if (feature) await session?.activity.record({ feature, action, outcome: 'error', reason: errorKind(err) })
  } finally {
    await session?.close().catch(() => undefined)
    await shutdown().catch(() => undefined)
  }
  return ok ? 0 : 1
}
