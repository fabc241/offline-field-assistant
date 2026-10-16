/**
 * The warnings the services raise, as the person at the screen sees them: a
 * short title, and the services' own advice on what to do about it.
 */
import { STT_FLAG_HELP } from '../../../src/features/speech/speech-service.js'
import { FLAG_HELP } from '../../../src/features/translate/translation-service.js'
import { TTS_FLAG_HELP } from '../../../src/features/voice/read-aloud.js'
import { h, icon } from './dom.js'

/** Same advice as DOC_FLAG_HELP in the document service (kept apart: that module needs Node). */
export const DOC_HELP = { 'low-confidence': 'The text was hard to read. Compare it with the paper before relying on it.' }

export const FLAG_ADVICE: Record<string, string> = { ...STT_FLAG_HELP, ...FLAG_HELP, ...TTS_FLAG_HELP, ...DOC_HELP }

export const FLAG_TITLE: Record<string, string> = {
  'no-speech': 'Nothing heard',
  repetition: 'Probably misheard',
  'empty-output': 'No translation',
  'translation-loop': 'Broken translation',
  untranslated: 'Not translated',
  'numbers-changed': 'Check the numbers',
  'negation-changed': 'Check “not” and “no”',
  'term-changed': 'Meaning changed',
  'low-fidelity': 'Meaning may have drifted',
  'clock-time': 'Check the time',
  'no-audio': 'Part was not spoken',
  'too-long': 'Audio may ramble',
  'too-short': 'Audio may skip words',
  'low-confidence': 'Unclear on the page'
}

/** Flags after which the result should not be used at all. */
const SEVERE = new Set(['no-speech', 'repetition', 'empty-output', 'translation-loop', 'untranslated', 'numbers-changed', 'negation-changed', 'term-changed'])

export const isSevere = (flag: string) => SEVERE.has(flag)

/**
 * Whether a translated part of a document may be read aloud: it has words to
 * say, and none of its warnings says the translation should not be used.
 */
export const speakable = (part: { kept?: unknown; translation: string; flags: readonly string[] }) =>
  !part.kept && !!part.translation.trim() && !part.flags.some(isSevere)

export function flagView(flag: string): HTMLElement {
  return h(
    'div',
    { class: `flag ${isSevere(flag) ? 'severe' : ''}` },
    icon('alert'),
    h('span', null, h('strong', null, FLAG_TITLE[flag] ?? flag), '. ', FLAG_ADVICE[flag] ?? '')
  )
}

export function flagsView(flags: readonly string[]): HTMLElement | null {
  return flags.length ? h('div', { class: 'flags' }, flags.map(flagView)) : null
}
