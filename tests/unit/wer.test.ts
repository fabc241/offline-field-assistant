import { describe, expect, it } from 'vitest'
import { corpusRates, editDistance, errorCounts, normalizeForWer } from '../../src/core/wer.js'

describe('normalizeForWer', () => {
  it('ignores case, punctuation and quote style, keeps apostrophes inside words', () => {
    expect(normalizeForWer('“Don’t stop,” she said — NOW!')).toBe("don't stop she said now")
    expect(normalizeForWer("Ng'ombe wa mama; wapi?")).toBe("ng'ombe wa mama wapi")
    expect(normalizeForWer('Jeni: fiche na zilizoelezewa.')).toBe('jeni fiche na zilizoelezewa')
    expect(normalizeForWer('5-day course, 2/3 doses')).toBe('5 day course 2 3 doses')
  })
})

describe('error rates', () => {
  it('counts substitutions, insertions and deletions', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toBe(2)
    expect(editDistance([], ['a'])).toBe(1)
    expect(editDistance(['a'], [])).toBe(1)
  })

  it('scores a style-only difference as zero errors', () => {
    expect(errorCounts('Mtoto ana homa.', 'mtoto ana homa')).toMatchObject({ wordErrors: 0, words: 3, charErrors: 0 })
  })

  it('computes corpus WER and CER over all references', () => {
    const counts = [errorCounts('mtoto ana homa', 'mtoto ana joto'), errorCounts('a b c d e f g', 'a b c d e f g')]
    const { wer, cer } = corpusRates(counts)
    expect(wer).toBeCloseTo(10, 5) // 1 error in 10 words
    expect(cer).toBeGreaterThan(0)
    expect(corpusRates([])).toEqual({ wer: 0, cer: 0 })
  })
})
