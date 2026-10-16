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
 *   ofa models status|install|verify|build|sign …
 *   ofa phrase list|search|play …
 *   ofa guide [--lang en|sw] "question" | --voice clip.wav --lang en|sw | --card ID
 *   ofa doc translate FILE --to en|sw [--out result.json] [--no-check] [--json] | doc read FILE
 *   ofa license show|device-id|install|issue …
 *   ofa logs status|export|wipe …
 *
 * The packaged app runs the same commands: offline-field-assistant ofa doctor
 */
import { runOfa } from './run.js'

process.exit(await runOfa(process.argv.slice(2)))
