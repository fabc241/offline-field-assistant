/**
 * Word and character error rates. Reference and hypothesis go through the
 * same normalizer, so models that differ only in casing or punctuation style
 * score the same. Numbers are not spelled out: "8" vs "eight" counts as an
 * error for every model alike.
 */

export function normalizeForWer(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[-–—/]/g, ' ')
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ') // punctuation, symbols
    .replace(/(^|\s)'+|'+(?=\s|$)/g, '$1') // quotes, but not apostrophes inside words
    .replace(/\s+/g, ' ')
    .trim()
}

/** Minimum substitutions + insertions + deletions turning `ref` into `hyp`. */
export function editDistance<T>(ref: readonly T[], hyp: readonly T[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j)
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i]
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[hyp.length]!
}

export interface ErrorCounts {
  wordErrors: number
  words: number
  charErrors: number
  chars: number
}

export function errorCounts(reference: string, hypothesis: string): ErrorCounts {
  const ref = normalizeForWer(reference)
  const hyp = normalizeForWer(hypothesis)
  const words = (s: string) => (s ? s.split(' ') : [])
  return {
    wordErrors: editDistance(words(ref), words(hyp)),
    words: words(ref).length,
    charErrors: editDistance([...ref], [...hyp]),
    chars: [...ref].length
  }
}

/** Corpus rates (total errors over total reference length), in percent. */
export function corpusRates(counts: ErrorCounts[]): { wer: number; cer: number } {
  const sum = (k: keyof ErrorCounts) => counts.reduce((s, c) => s + c[k], 0)
  return {
    wer: (100 * sum('wordErrors')) / Math.max(1, sum('words')),
    cer: (100 * sum('charErrors')) / Math.max(1, sum('chars'))
  }
}
