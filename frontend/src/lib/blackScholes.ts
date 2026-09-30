import type { OptionType } from "@/lib/data";

/** Normal CDF, Abramowitz-Stegun 7.1.26 (max abs. error ~1.5e-7) — no
 *  server round-trip needed for a closed-form price. */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - d * poly;
  return x >= 0 ? p : 1 - p;
}

/** Black-76 price, undiscounted (matches backend/options_edge/pricing.py::black76_price,
 *  which drops the discount factor for short-dated equity options). */
export function black76Price(forward: number, strike: number, timeToExpiry: number, vol: number, optionType: OptionType): number {
  const intrinsic = optionType === "CE" ? Math.max(forward - strike, 0) : Math.max(strike - forward, 0);
  if (timeToExpiry <= 0 || vol <= 0) return intrinsic;

  const sqrtT = Math.sqrt(timeToExpiry);
  const d1 = (Math.log(forward / strike) + 0.5 * vol * vol * timeToExpiry) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  return optionType === "CE"
    ? forward * normCdf(d1) - strike * normCdf(d2)
    : strike * normCdf(-d2) - forward * normCdf(-d1);
}

/** Invert Black-76 for vol by bisection, for strikes the cleaned IV surface
 *  doesn't cover (thin/crossed quotes — often exactly the strikes where an
 *  arbitrage violation shows up) but that still have a price actually paid. */
export function impliedVol(price: number, forward: number, strike: number, timeToExpiry: number, optionType: OptionType): number | null {
  const intrinsic = optionType === "CE" ? Math.max(forward - strike, 0) : Math.max(strike - forward, 0);
  if (timeToExpiry <= 0 || price <= intrinsic) return null;

  let lo = 1e-4;
  let hi = 5;
  if (black76Price(forward, strike, timeToExpiry, hi, optionType) < price) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (black76Price(forward, strike, timeToExpiry, mid, optionType) < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
