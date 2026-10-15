/** Corpus chrF (character 1–6-grams, β = 2, whitespace ignored), 0–100. */
export function chrF(hyps: string[], refs: string[], maxN = 6, beta = 2): number {
  const match = new Array<number>(maxN).fill(0)
  const hypTotal = new Array<number>(maxN).fill(0)
  const refTotal = new Array<number>(maxN).fill(0)
  const grams = (s: string, n: number) => {
    const counts = new Map<string, number>()
    const chars = [...s.replace(/\s+/g, '')]
    for (let i = 0; i + n <= chars.length; i++) {
      const g = chars.slice(i, i + n).join('')
      counts.set(g, (counts.get(g) ?? 0) + 1)
    }
    return counts
  }
  hyps.forEach((hyp, i) => {
    for (let n = 1; n <= maxN; n++) {
      const h = grams(hyp, n)
      const r = grams(refs[i]!, n)
      for (const [g, c] of h) match[n - 1]! += Math.min(c, r.get(g) ?? 0)
      for (const c of h.values()) hypTotal[n - 1]! += c
      for (const c of r.values()) refTotal[n - 1]! += c
    }
  })
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const p = avg(match.map((m, i) => (hypTotal[i] ? m / hypTotal[i]! : 0)))
  const r = avg(match.map((m, i) => (refTotal[i] ? m / refTotal[i]! : 0)))
  const b2 = beta * beta
  return p + r ? (100 * (1 + b2) * p * r) / (b2 * p + r) : 0
}
