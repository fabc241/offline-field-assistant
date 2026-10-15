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
 */
import { parseArgs } from 'node:util'
import { loadConfig } from '../core/config.js'
import { shutdown } from '../core/qvac.js'
import { converseCommand } from './converse.js'
import { docCommand } from './doc.js'
import { doctor } from './doctor.js'
import { guideCommand } from './guide.js'
import { packCommand } from './pack.js'
import { phraseCommand } from './phrase.js'
import { speakCommand } from './speak.js'
import { sttCommand } from './stt.js'
import { translateCommand } from './translate.js'

type Command = (args: string[]) => Promise<boolean>

const commands: Record<string, Command> = {
  async doctor(args) {
    const { values } = parseArgs({
      args,
      options: { verify: { type: 'boolean', default: false }, load: { type: 'boolean', default: false } }
    })
    return doctor(loadConfig(), { verify: values.verify, load: values.load })
  },
  translate: (args) => translateCommand(loadConfig(), args),
  stt: (args) => sttCommand(loadConfig(), args),
  speak: (args) => speakCommand(loadConfig(), args),
  converse: (args) => converseCommand(loadConfig(), args),
  pack: (args) => packCommand(loadConfig(), args),
  phrase: (args) => phraseCommand(loadConfig(), args),
  guide: (args) => guideCommand(loadConfig(), args),
  doc: (args) => docCommand(loadConfig(), args)
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
