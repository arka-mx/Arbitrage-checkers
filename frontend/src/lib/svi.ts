export type SviParams = { a: number; b: number; rho: number; m: number; sigma: number };

/** Raw SVI total variance w(k) at strike K, in log-moneyness k = ln(K/F). */
export function sviTotalVariance(p: SviParams, strike: number, forward: number): number {
  const k = Math.log(strike / forward);
  return p.a + p.b * (p.rho * (k - p.m) + Math.sqrt((k - p.m) ** 2 + p.sigma ** 2));
}

/** Implied vol at strike K from the fitted SVI slice: sqrt(max(w, 0) / T). */
export function sviImpliedVol(p: SviParams, strike: number, forward: number, timeToExpiry: number): number {
  return Math.sqrt(Math.max(sviTotalVariance(p, strike, forward), 0) / timeToExpiry);
}
