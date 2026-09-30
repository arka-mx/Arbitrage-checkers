import { useSyncExternalStore } from "react";

import type { OptionType } from "@/lib/data";

/** Positions live in this browser's localStorage — a personal single-user
 *  tool, no account system, so there's nowhere else for them to live. */

export type Side = "short" | "long";

export type Position = {
  id: string;
  symbol: string;
  optionType: OptionType;
  strike: number;
  expiry: string; // YYYY-MM-DD
  side: Side; // short = wrote/sold it (received entryPremium); long = bought it (paid entryPremium)
  contracts: number;
  entryPremium: number; // $/share, per contract, at entry: market bid if short, market ask if long
  entrySpot: number;
  /** IV at entry, when known (single-leg entries only — an arbitrage strategy's
   *  legs don't carry one; the payoff projection always sources a live vol
   *  from the current IV surface instead, never this stale snapshot). */
  entryVol?: number;
  /** Shared across every leg entered together (an arbitrage strategy),
   *  a single-leg entry's own id otherwise — groups legs for a combined
   *  payoff projection. */
  strategyId: string;
  enteredAt: string; // ISO
  status: "open" | "closed";
  closePremium?: number; // $/share, per contract, to close: opposite side of entryPremium
  closedAt?: string;
};

/** Which side of the current quote closes a position: buy back a short at
 *  the ask, sell a long at the bid. */
export const closingQuoteField = (side: Side): "ask" | "bid" => (side === "short" ? "ask" : "bid");

const STORAGE_KEY = "edge-vs-costs:positions:v1";
const CHANGE_EVENT = "edge-vs-costs:positions-changed";

// useSyncExternalStore requires getSnapshot to return a referentially stable
// value when nothing changed, or React re-renders forever. Cache the parse
// keyed on the raw string so unchanged storage returns the same array.
let cache: { raw: string | null; parsed: Position[] } = { raw: null, parsed: [] };
let cacheInitialized = false;

function read(): Position[] {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (cacheInitialized && raw === cache.raw) return cache.parsed;

  let parsed: Position[] = [];
  try {
    // Positions saved before `side`/`strategyId` existed default to "short"
    // (the only kind this tool could enter back then) and to their own id
    // (their own single-leg group), so old localStorage still loads.
    const stored = raw
      ? (JSON.parse(raw) as (Omit<Position, "side" | "strategyId"> & { side?: Side; strategyId?: string })[])
      : [];
    parsed = stored.map((p) => ({ ...p, side: p.side ?? "short", strategyId: p.strategyId ?? p.id }));
  } catch {
    parsed = [];
  }
  cache = { raw, parsed };
  cacheInitialized = true;
  return parsed;
}

function write(positions: Position[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // best-effort: private mode / quota / disabled storage
  }
  // Fires even if the write above failed to throw, so in-memory subscribers
  // (this tab) still see the attempted change reflected by a fresh read.
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange); // updates from other tabs
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const EMPTY: Position[] = [];

/** Live-updating list of every position, newest first. Safe during SSR
 *  (returns an empty list server-side; the real list arrives on hydration). */
export function usePositions(): Position[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function enterPosition(input: Omit<Position, "id" | "enteredAt" | "status" | "strategyId">): Position {
  return enterPositions([input])[0];
}

/** Save every leg of a strategy together, so an arbitrage entry can never
 * partially overwrite a preceding leg in local storage. */
export function enterPositions(inputs: Omit<Position, "id" | "enteredAt" | "status" | "strategyId">[]): Position[] {
  const enteredAt = new Date().toISOString();
  const strategyId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const positions = inputs.map((input) => ({
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    strategyId,
    enteredAt,
    status: "open" as const,
  }));
  write([...positions, ...read()]);
  return positions;
}

export function closePosition(id: string, closePremium: number): void {
  write(read().map((p) => (p.id === id ? { ...p, status: "closed", closePremium, closedAt: new Date().toISOString() } : p)));
}

export function reopenPosition(id: string): void {
  write(read().map((p) => (p.id === id ? { ...p, status: "open", closePremium: undefined, closedAt: undefined } : p)));
}

export function deletePosition(id: string): void {
  write(read().filter((p) => p.id !== id));
}

/** Per-share P&L. Short: premium received minus premium paid to close.
 *  Long: premium received on close minus premium paid to enter — the mirror. */
export function pnlPerShare(p: Position, markPremium: number | null): number | null {
  const closePremium = p.status === "closed" ? (p.closePremium ?? 0) : markPremium;
  if (closePremium === null) return null;
  return p.side === "short" ? p.entryPremium - closePremium : closePremium - p.entryPremium;
}
