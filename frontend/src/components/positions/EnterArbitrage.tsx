"use client";

import { useId, useMemo, useState } from "react";

import { impliedVol } from "@/lib/blackScholes";
import type { Quote, Violation } from "@/lib/data";
import { expiryKey, fmtInt, fmtPrice } from "@/lib/format";
import { yearsToExpiry } from "@/lib/payoff";
import { enterPositions, type Side } from "@/lib/positions";

type Leg = { strike: number; expiry: string; side: Side; ratio: number; price: number | null };

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

function butterflyRatios(k1: number, k2: number, k3: number) {
  // Convert strikes to mills first so standard $0.50/$1/$5 strike grids all
  // result in whole, minimum contract ratios.
  const left = Math.round((k2 - k1) * 1000);
  const right = Math.round((k3 - k2) * 1000);
  const divisor = gcd(gcd(left, right), left + right);
  return { low: right / divisor, body: (left + right) / divisor, high: left / divisor };
}

export function EnterArbitrage({ violation, quotes, symbol, spot }: {
  violation: Violation; quotes: Quote[]; symbol: string; spot: number;
}) {
  const id = useId();
  const [units, setUnits] = useState(1);
  const [entered, setEntered] = useState(false);

  const legs = useMemo<Leg[]>(() => {
    const quoteFor = (expiry: string, strike: number) =>
      quotes.find((q) => expiryKey(q.expiry) === expiryKey(expiry) && q.strike === strike && q.option_type === violation.option_type);
    const leg = (expiry: string, strike: number, side: Side, ratio: number): Leg => {
      const q = quoteFor(expiry, strike);
      return { expiry: expiryKey(expiry), strike, side, ratio, price: q?.[side === "long" ? "ask" : "bid"] ?? null };
    };
    if (violation.kind === "calendar") {
      return [leg(violation.expiry, violation.k1, "short", 1), leg(violation.expiry_far!, violation.k1, "long", 1)];
    }
    const ratios = butterflyRatios(violation.k1, violation.k2!, violation.k3!);
    return [
      leg(violation.expiry, violation.k1, "long", ratios.low),
      leg(violation.expiry, violation.k2!, "short", ratios.body),
      leg(violation.expiry, violation.k3!, "long", ratios.high),
    ];
  }, [quotes, violation]);

  const ready = legs.every((leg) => leg.price !== null);
  const contracts = legs.reduce((n, leg) => n + leg.ratio * units, 0);
  const cash = legs.reduce((n, leg) => n + (leg.side === "short" ? -1 : 1) * (leg.price ?? 0) * leg.ratio * units * 100, 0);
  const strategy = violation.kind === "butterfly" ? "butterfly" : "calendar";

  if (entered) {
    return <span className="text-[12px] font-medium text-good">Position entered</span>;
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <label className="sr-only" htmlFor={id}>Strategy units</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        value={units}
        onChange={(e) => {
          const value = Math.round(Number(e.target.value));
          if (Number.isFinite(value) && value >= 1) setUnits(value);
        }}
        className="w-12 rounded-md border border-line bg-surface px-1.5 py-1 text-right text-[12px] tabular-nums text-ink outline-none focus:border-series-1 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        aria-label={`Number of ${strategy} strategy units`}
      />
      <button
        type="button"
        disabled={!ready}
        title={ready ? `Enter ${contracts} contracts; estimated debit ${fmtPrice(cash)}` : "A current quote is missing for one or more legs"}
        onClick={() => {
          if (!ready) return;
          enterPositions(legs.map((leg) => {
            const t = yearsToExpiry(leg.expiry, Date.now());
            const entryVol = impliedVol(leg.price!, spot, leg.strike, t, violation.option_type) ?? undefined;
            return {
              symbol, optionType: violation.option_type, strike: leg.strike, expiry: leg.expiry,
              side: leg.side, contracts: leg.ratio * units, entryPremium: leg.price!, entrySpot: spot, entryVol,
            };
          }));
          setEntered(true);
        }}
        className="whitespace-nowrap rounded-md bg-series-1 px-2.5 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Enter {fmtInt(contracts)} legs
      </button>
    </div>
  );
}
