/**
 * Splits text into sentences for line-at-a-time translation, keeping the
 * layout so translated sentences can be put back in place.
 */

export interface Line {
  /** Sentences on this line; empty for a blank line. */
  sentences: string[]
  /** The line break that followed this line in the input ('' for the last). */
  eol: string
}

/** Titles Intl.Segmenter treats as sentence ends ("Dr. Juma" → "Dr. " + "Juma"). */
const TITLE = /\b(?:dr|mr|mrs|ms|prof|st|no|nr|bi|bw)\.$/i

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })

export function splitSentences(line: string): string[] {
  const out: string[] = []
  let carry = ''
  for (const { segment } of segmenter.segment(line)) {
    const sentence = carry + segment
    if (TITLE.test(sentence.trimEnd())) {
      carry = sentence
      continue
    }
    carry = ''
    if (sentence.trim()) out.push(sentence.trim())
  }
  if (carry.trim()) out.push(carry.trim())
  return out
}

export function segment(text: string): Line[] {
  const parts = text.split(/(\r?\n)/)
  const lines: Line[] = []
  for (let i = 0; i < parts.length; i += 2) {
    lines.push({ sentences: splitSentences(parts[i]!), eol: parts[i + 1] ?? '' })
  }
  return lines
}

/** Rebuilds the layout of `lines` around `replacements`, one per sentence in order. */
export function reassemble(lines: Line[], replacements: string[]): string {
  let i = 0
  return lines.map((l) => l.sentences.map(() => replacements[i++] ?? '').join(' ') + l.eol).join('')
}
