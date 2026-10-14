/** Text clean-up and sanity checks on Whisper output. */
import type { TranscriptSegment } from '../../core/engines.js'

/** A segment that is only a sound annotation: "[Music]", "(laughs)", "*coughs*". */
const ANNOTATION = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)\s*$/

/** Joins segments into display text, dropping sound annotations Whisper sometimes emits. */
export function joinSegments(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => s.text)
    .filter((t) => !ANNOTATION.test(t))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim()
}

/**
 * Whisper's typical failure on noise or long silence is a decoding loop: the
 * same word or phrase over and over. Flags a phrase of n words repeated back
 * to back at least `minRepeats(n)` times. Real speech repeats a word three
 * times ("no, no, no") but rarely a whole phrase.
 */
export function hasRepetitionLoop(text: string): boolean {
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
  const minRepeats = (n: number) => (n === 1 ? 5 : 3)
  for (let n = 1; n <= 8; n++) {
    for (let start = 0; start + n * minRepeats(n) <= words.length; start++) {
      let repeats = 1
      while (sameRun(words, start, start + repeats * n, n)) repeats++
      if (repeats >= minRepeats(n)) return true
    }
  }
  return false
}

function sameRun(words: string[], a: number, b: number, n: number): boolean {
  if (b + n > words.length) return false
  for (let i = 0; i < n; i++) if (words[a + i] !== words[b + i]) return false
  return true
}
