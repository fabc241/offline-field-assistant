import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { AppConfig } from '../core/config.js'
import { LOG_RETENTION_DAYS, type LogProblem, type LogReadResult, type SecureLog } from '../features/platform/secure-log.js'
import type { Session } from './session.js'

const USAGE = `Usage:
  ofa logs status [--json]                     days kept, lines, and whether every line checks out
  ofa logs export [--out FILE] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
                                               decrypt for review: one JSON record per line (stdout, or FILE created 0600)
  ofa logs wipe --yes                          delete every log file and the log key
Lines are kept ${LOG_RETENTION_DAYS} days. Transcripts are logged only with OFA_LOG_TRANSCRIPTS=1.`

const DAY = /^\d{4}-\d{2}-\d{2}$/

type Sub = (log: SecureLog, config: AppConfig, args: string[], session: Session) => Promise<boolean>

export async function logsCommand(config: AppConfig, args: string[], session: Session): Promise<boolean> {
  const [sub, ...rest] = args
  const run = sub ? subcommands[sub] : undefined
  if (!run) return usage()
  if (!session.log) {
    console.error('✖ The activity log needs the macOS Keychain')
    return false
  }
  return run(session.log, config, rest, session)
}

const subcommands: Record<string, Sub> = {
  async status(log, config, args, session) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false } } })
    const files = await log.files()
    const read = await log.read()
    const bytes = (await log.files()).reduce((s, f) => s + f.bytes, 0)
    if (values.json) {
      const { entries, ...rest } = read
      console.log(JSON.stringify({ dir: log.dir, keyStore: session.keys?.name, transcripts: config.logTranscripts, entries: entries.length, bytes, ...rest }, null, 2))
      return read.problems.length === 0
    }
    console.log(`Activity log   ${log.dir}`)
    console.log(`  key          ${read.keyId ? `${read.keyId} in ${session.keys?.name}` : `none yet (${session.keys?.name})`}`)
    console.log(`  recording    metadata${config.logTranscripts ? ' and transcripts (OFA_LOG_TRANSCRIPTS=1)' : ' only'}; kept ${LOG_RETENTION_DAYS} days`)
    console.log(`  kept         ${read.days.length ? `${read.days[0]} to ${read.days.at(-1)}, ${read.days.length} day${read.days.length > 1 ? 's' : ''}` : 'nothing'}; ${read.lines} lines, ${(bytes / 1024).toFixed(0)} KB`)
    if (files.length > read.days.length) console.log(`  pruned       ${files.length - read.days.length} day files past retention`)
    return printProblems(read)
  },

  async export(log, _config, args, session) {
    const { values } = parseArgs({ args, options: { out: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' } } })
    if ((values.since && !DAY.test(values.since)) || (values.until && !DAY.test(values.until))) return usage()
    const read = await log.read({ ...(values.since ? { since: values.since } : {}), ...(values.until ? { until: values.until } : {}) })
    const text = read.entries.map((e) => JSON.stringify(e.record)).join('\n') + (read.entries.length ? '\n' : '')
    if (values.out) {
      await fs.mkdir(path.dirname(path.resolve(values.out)), { recursive: true })
      // Decrypted records: only for the reviewer, never over another file.
      await fs.writeFile(values.out, text, { flag: 'wx', mode: 0o600 })
    } else {
      process.stdout.write(text)
    }
    await session.activity.record({
      feature: 'logs',
      action: 'export',
      outcome: 'ok',
      counts: { entries: read.entries.length, problems: read.problems.length, days: read.days.length }
    })
    console.error(`Exported ${read.entries.length} records from ${read.days.length} day${read.days.length === 1 ? '' : 's'}${values.out ? ` to ${values.out}` : ''}`)
    return printProblems(read)
  },

  async wipe(log, _config, args, session) {
    const { values } = parseArgs({ args, options: { yes: { type: 'boolean', default: false } } })
    if (!values.yes) {
      console.error('This deletes every activity log file and the log key; nothing can be recovered. Run again with --yes.')
      return false
    }
    const wiped = await log.wipe()
    // The new log starts by saying the old one was wiped.
    await session.activity.record({ feature: 'logs', action: 'wipe', outcome: 'ok', counts: { files: wiped.files, bytes: wiped.bytes } })
    console.log(`Wiped ${wiped.files} log files (${(wiped.bytes / 1024).toFixed(0)} KB) and deleted the log key.`)
    return true
  }
}

const PROBLEM_HELP: Record<LogProblem['problem'], string> = {
  malformed: 'not a valid log line (edited or cut short)',
  'unknown-key': 'written with another log key (deleted since), cannot be read',
  tampered: 'fails its integrity check: edited, or moved from another day or position',
  'missing-lines': 'lines before this one were removed',
  'out-of-order': 'a line was duplicated or moved'
}

function printProblems(read: LogReadResult): boolean {
  if (!read.problems.length) {
    if (read.lines) console.error(`  ✓ all ${read.lines} lines decrypt and check out`)
    return true
  }
  console.error(`\n⚠ ${read.problems.length} problem${read.problems.length > 1 ? 's' : ''}:`)
  for (const p of read.problems.slice(0, 20)) {
    console.error(`  ${p.day} line ${p.line}: ${p.problem}${p.count ? ` (${p.count})` : ''} — ${PROBLEM_HELP[p.problem]}`)
  }
  if (read.problems.length > 20) console.error(`  … and ${read.problems.length - 20} more`)
  return false
}

function usage(): false {
  console.error(USAGE)
  return false
}
