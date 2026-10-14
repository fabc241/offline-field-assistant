/** Small summary statistics shared by the eval scripts. */

/** Nearest-rank quantile; NaN for an empty list. */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN
}

export function round(x: number, digits = 3): number {
  return Number(x.toFixed(digits))
}
