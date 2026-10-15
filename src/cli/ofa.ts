#!/usr/bin/env -S npx tsx
/**
 * ofa — headless command line for the Offline Field Assistant core.
 *
 *   ofa doctor [--verify] [--load]
 *   ofa translate --from en|sw --to sw|en [--plain] [--json] "text"
 *   ofa stt --lang en|sw [--model NAME] [--json] clip.wav
 *   ofa speak --lang en|sw [--play] [--out FILE.wav] [--chunk-tokens N] [--raw] [--json] "text"
 *   ofa converse --side clinician|patient [--play] [--out-dir DIR] [--json] turn.wav
 *   ofa pack keygen|build|sign|verify|install|list …
 *   ofa phrase list|search|play …
 *   ofa guide [--lang en|sw] "question" | --voice clip.wav --lang en|sw | --card ID
 *   ofa doc translate FILE --to en|sw [--out result.json] [--no-check] [--json] | doc read FILE
 *   ofa license show|device-id|install|issue …
 *   ofa logs status|export|wipe …
 *
 * Every command starts by checking the license (see features/platform/license.ts)
 * and records what it did, metadata only, in the encrypted activity log.
 */
import { parseArgs } from 'node:util'
import { loadConfig, type AppConfig } from '../core/config.js'
import { shutdown } from '../core/qvac.js'
import { errorKind, type ActivityFeature } from '../features/platform/activity.js'
import { converseCommand } from './converse.js'
import { docCommand } from './doc.js'
import { doctor } from './doctor.js'
import { guideCommand } from './guide.js'
import { licenseCommand } from './license.js'
import { logsCommand } from './logs.js'
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
  phrase: 'phrasebook',
  guide: 'guide',
  doc: 'documents',
  license: 'license',
  logs: 'logs'
}

const WITH_SUBCOMMANDS = new Set(['pack', 'phrase', 'doc', 'license', 'logs'])

const [name, ...rest] = process.argv.slice(2)
const command = name ? commands[name] : undefined
if (!command) {
  console.error(`Usage: ofa <${Object.keys(commands).join('|')}> [options]`)
  process.exit(2)
}

let ok = false
let session: Session | undefined
try {
  const config = loadConfig()
  session = await openSession(config)
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
process.exit(ok ? 0 : 1)
