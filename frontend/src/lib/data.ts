import "server-only";

import fs from "node:fs";
import path from "node:path";
import { cache } from "react";
import { connection } from "next/server";

import { expiryKey } from "./format";

// Pipeline outputs, written by `python -m options_edge.cli --also-json --svi --arb`.
// Types mirror the Python column names exactly; NaN arrives as null.

export const SYMBOL = (process.env.CHAIN_SYMBOL ?? "SPY").toUpperCase();
const DATA_DIR = path.join(process.cwd(), "..", "backend", "data");

export type OptionType = "CE" | "PE";

export type Quote = {
  occ_symbol: string;
  expiry: string;
  strike: number;
  option_type: OptionType;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  spread_pct: number;
  bid_size: number | null;
  ask_size: number | null;
  quote_time: string | null;
  ltp: number | null;
  oi: number | null;
  alpaca_iv: number | null;
  underlying: number;
  feed: string | null;
  fetched_at: string;
};

export type IvRow = {
  expiry: string;
  strike: number;
  option_type: OptionType;
  forward: number | null;
  discount_factor: number | null;
  time_to_expiry: number;
  bid: number;
  ask: number;
  mid: number;
  iv_bid: number | null;
  iv_mid: number | null;
  iv_ask: number | null;
};

export type SviRow = {
  expiry: string;
  forward: number;
  time_to_expiry: number;
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
  n_points: number;
  rmse_iv: number;
};

export type Violation = {
  kind: "butterfly" | "calendar";
  option_type: OptionType;
  expiry: string;
  expiry_far: string | null;
  k1: number;
  k2: number | null;
  k3: number | null;
  mid_value: number;
  exec_value: number;
  commission: number;
  survives: boolean;
  leg_time_skew_s: number | null;
};

type Counts = { checked: number; violations: number; survive: number };

export type ArbSummary = {
  butterfly: Counts;
  calendar: Counts;
  total: Counts;
  commission_per_contract: number;
  meta: { symbol: string; feed: string; fetched_at: string | null; underlying: number | null; computed_at?: string };
};

export type DensityPoint = { expiry: string; strike: number; density: number; cdf: number };

export type RegimeStats = { label: "low" | "medium" | "high"; vol_mean: number; vol_std: number; days: number };

export type RegimeSummary = {
  symbol: string;
  computed_at: string;
  lookback_days: number;
  current_regime: "low" | "medium" | "high";
  current_vol: number;
  regimes: RegimeStats[];
  daily_drift: number;
};

export type SnapshotMeta = {
  symbol: string;
  underlying: number;
  fetchedAt: string;
  feed: string | null;
  quoteCount: number;
  expiries: string[];
};

// expiryKey lives in ./format (client-safe: no server-only dependency) since
// client components need it too. Re-exported here so existing server-side
// `import { expiryKey } from "@/lib/data"` call sites keep working.
export { expiryKey };

const readJson = cache(async <T,>(name: string): Promise<T | null> => {
  await connection(); // sync fs reads: render per request, never at build time
  const file = path.join(DATA_DIR, `${SYMBOL}_${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
});

export const loadQuotes = () => readJson<Quote[]>("snapshot");
export const loadIv = () => readJson<IvRow[]>("iv");
export const loadSvi = () => readJson<SviRow[]>("svi");
export const loadViolations = () => readJson<Violation[]>("arb");
export const loadArbSummary = () => readJson<ArbSummary>("arb_summary");
export const loadDensity = () => readJson<DensityPoint[]>("density");
export const loadRegime = () => readJson<RegimeSummary>("regime");

export const loadMeta = cache(async (): Promise<SnapshotMeta | null> => {
  const quotes = await loadQuotes();
  if (!quotes || quotes.length === 0) return null;
  return {
    symbol: SYMBOL,
    underlying: quotes[0].underlying,
    fetchedAt: quotes[0].fetched_at,
    feed: quotes[0].feed ?? null,
    quoteCount: quotes.length,
    expiries: [...new Set(quotes.map((q) => expiryKey(q.expiry)))].sort(),
  };
});
