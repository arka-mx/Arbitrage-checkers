import { black76Price } from "@/lib/blackScholes";
import type { OptionType, RegimeSummary } from "@/lib/data";
import type { Side } from "@/lib/positions";

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
const N_PATHS = 500; // Monte Carlo draws per leg per day — plenty for a smooth UI curve

export type PayoffLeg = {
  strike: number;
  optionType: OptionType;
  side: Side;
  contracts: number;
  expiry: string; // YYYY-MM-DD
  vol: number | null; // current implied vol at this strike; null = no live quote to project from
};

export type PayoffPoint = { day: number; pnl: number };

/** Time to a given expiry date's ~market close, in years, from `atMs`. */
export function yearsToExpiry(expiry: string, atMs: number): number {
  const close = Date.parse(`${expiry}T20:00:00Z`); // ~4pm ET, matching the backend's expiry convention
  return Math.max(0, close - atMs) / YEAR_MS;
}

/** Whole days from `now` to a leg's own expiry close. */
export function daysFromNow(expiry: string, now: number): number {
  return Math.max(0, Math.ceil(yearsToExpiry(expiry, now) * 365));
}

/** The current realized-vol regime's own annualized vol and drift — what
 *  drives the simulated spot paths (a *physical-measure* forecast, from the
 *  underlying's actual trailing behavior), kept separate from the vol used
 *  to reprice each option (its own market-implied vol, unchanged). */
export type RegimeAssumption = { volAnnual: number; driftAnnual: number; label: RegimeSummary["current_regime"] };

export function regimeAssumption(regime: RegimeSummary | null): RegimeAssumption | null {
  if (!regime) return null;
  const current = regime.regimes.find((r) => r.label === regime.current_regime);
  if (!current || current.vol_mean <= 0) return null;
  return { volAnnual: current.vol_mean, driftAnnual: regime.daily_drift * 252, label: regime.current_regime };
}

/** Deterministic standard-normal draws (mulberry32 PRNG + Box-Muller) — a
 *  fixed seed so the projection curve is stable across re-renders instead
 *  of jittering, and the same draws are reused for every day of one
 *  projection so the curve's shape is smooth (each day just rescales the
 *  same underlying shocks by that day's own sqrt(time), rather than being
 *  independently re-sampled and noisy point to point). */
function standardNormals(n: number, seed: number): Float64Array {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

/**
 * Expected Black-76 value of one leg at a future day, under the regime's
 * simulated spot distribution — the underlying is stochastic (drawn from
 * the current realized-vol regime), but each draw is still priced with the
 * leg's own fixed implied vol, the market's own input, not the regime's.
 * At day 0 there's nothing to simulate: it's priced at today's actual spot.
 */
function expectedLegPrice(leg: PayoffLeg, spot: number, now: number, day: number, regime: RegimeAssumption, zs: Float64Array): number {
  const tRemaining = yearsToExpiry(leg.expiry, now + day * DAY_MS);
  const vol = leg.vol as number;
  if (day === 0) return black76Price(spot, leg.strike, tRemaining, vol, leg.optionType);

  const tElapsed = day / 365;
  const drift = (regime.driftAnnual - 0.5 * regime.volAnnual * regime.volAnnual) * tElapsed;
  const diffusion = regime.volAnnual * Math.sqrt(tElapsed);
  let sum = 0;
  for (let i = 0; i < zs.length; i++) {
    const simSpot = spot * Math.exp(drift + diffusion * zs[i]);
    sum += black76Price(simSpot, leg.strike, tRemaining, vol, leg.optionType);
  }
  return sum / zs.length;
}

/**
 * Projected P&L for a strategy (one leg, or several sharing a strategyId)
 * from today (day 0, pinned exactly to `livePnLNow`) out to `maxDays`.
 *
 * With a regime available, each day beyond today is the *expectation* over
 * simulated spot paths drawn from the current realized-vol regime (a
 * Monte Carlo forecast grounded in the underlying's actual trailing
 * behavior) rather than a single flat "spot never moves" assumption.
 * Without one (regime detection unavailable), falls back to that flat
 * assumption — spot held at today's level, only time passing.
 *
 * Returns null if any leg is missing a live vol to project from.
 */
export function projectStrategyPayoff(
  legs: PayoffLeg[],
  livePnLNow: number,
  spot: number,
  now: number,
  maxDays: number,
  regime: RegimeAssumption | null,
): PayoffPoint[] | null {
  if (legs.some((leg) => leg.vol == null || (leg.vol as number) <= 0)) return null;

  const zs = regime ? standardNormals(N_PATHS, 0x5eed) : new Float64Array(0);
  const priceAt = (leg: PayoffLeg, day: number) =>
    regime
      ? expectedLegPrice(leg, spot, now, day, regime, zs)
      : black76Price(spot, leg.strike, yearsToExpiry(leg.expiry, now + day * DAY_MS), leg.vol as number, leg.optionType);

  const model0 = legs.map((leg) => priceAt(leg, 0));
  const days = Array.from({ length: maxDays + 1 }, (_, i) => i);
  return days.map((day) => {
    let delta = 0;
    legs.forEach((leg, i) => {
      const sign = leg.side === "short" ? -1 : 1;
      delta += sign * (priceAt(leg, day) - model0[i]) * 100 * leg.contracts;
    });
    return { day, pnl: livePnLNow + delta };
  });
}
