"use client";

import { useId, useMemo, useState } from "react";

import { Card, CardHeader } from "@/components/ui";
import type { OptionType, Quote, SviRow } from "@/lib/data";
import { expiryKey, fmtExpiry, fmtInt, fmtPrice } from "@/lib/format";
import { enterPositions, type Side } from "@/lib/positions";
import { sviImpliedVol } from "@/lib/svi";

type DraftLeg = { expiry: string; optionType: OptionType; strike: number; side: Side; contracts: number };

function quoteFor(quotes: Quote[], expiry: string, strike: number, optionType: OptionType) {
  return quotes.find((q) => expiryKey(q.expiry) === expiry && q.strike === strike && q.option_type === optionType);
}

function volFor(svi: SviRow[], expiry: string, strike: number): number | null {
  const fit = svi.find((f) => expiryKey(f.expiry) === expiry);
  return fit ? sviImpliedVol(fit, strike, fit.forward, fit.time_to_expiry) : null;
}

export function CustomStrategyBuilder({
  symbol, quotes, svi, expiries, spot,
}: {
  symbol: string; quotes: Quote[]; svi: SviRow[]; expiries: string[]; spot: number;
}) {
  const id = useId();
  const [legs, setLegs] = useState<DraftLeg[]>([]);
  const [entered, setEntered] = useState(false);

  const [expiry, setExpiry] = useState(expiries[0] ?? "");
  const [optionType, setOptionType] = useState<OptionType>("CE");
  const [side, setSide] = useState<Side>("long");
  const [strike, setStrike] = useState<number | null>(null);
  const [contracts, setContracts] = useState(1);

  const strikeOptions = useMemo(
    () =>
      [...new Set(quotes.filter((q) => expiryKey(q.expiry) === expiry && q.option_type === optionType).map((q) => q.strike))].sort(
        (a, b) => a - b,
      ),
    [quotes, expiry, optionType],
  );
  const draftQuote = strike !== null ? quoteFor(quotes, expiry, strike, optionType) : undefined;
  const draftPrice = draftQuote ? (side === "short" ? draftQuote.bid : draftQuote.ask) : null;

  const priced = legs.map((leg) => {
    const q = quoteFor(quotes, leg.expiry, leg.strike, leg.optionType);
    const price = q ? (leg.side === "short" ? q.bid : q.ask) : null;
    return { leg, price };
  });
  const ready = legs.length > 0 && priced.every((p) => p.price !== null);
  const netCash = priced.reduce((n, { leg, price }) => n + (leg.side === "short" ? 1 : -1) * (price ?? 0) * leg.contracts * 100, 0);

  if (entered) {
    return <p className="text-[13px] font-medium text-good">Strategy entered — see it on the Overview page.</p>;
  }

  return (
    <Card>
      <CardHeader
        title="Custom strategy"
        description="Build any combination of calls and puts, any strikes or expiries, long or short — enter it as one strategy with a combined payoff projection."
      />
      <div className="flex flex-wrap items-end gap-3 px-5 py-4 sm:px-6">
        <div>
          <label htmlFor={`${id}-expiry`} className="block text-[12px] text-ink-2">Expiry</label>
          <select
            id={`${id}-expiry`}
            value={expiry}
            onChange={(e) => {
              setExpiry(e.target.value);
              setStrike(null);
            }}
            className="mt-1 rounded-md border border-line bg-surface px-2 py-1.5 text-[13px] text-ink outline-none focus:border-series-1"
          >
            {expiries.map((k) => (
              <option key={k} value={k}>{fmtExpiry(k)}</option>
            ))}
          </select>
        </div>

        <div>
          <span className="block text-[12px] text-ink-2">Type</span>
          <div className="mt-1 flex rounded-md border border-line p-0.5">
            {(["CE", "PE"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setOptionType(t);
                  setStrike(null);
                }}
                className={`rounded px-2.5 py-1 text-[13px] font-medium transition-colors ${
                  optionType === t ? "bg-ink text-surface" : "text-ink-2 hover:text-ink"
                }`}
              >
                {t === "CE" ? "Call" : "Put"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor={`${id}-strike`} className="block text-[12px] text-ink-2">Strike</label>
          <select
            id={`${id}-strike`}
            value={strike ?? ""}
            onChange={(e) => setStrike(e.target.value === "" ? null : Number(e.target.value))}
            className="mt-1 rounded-md border border-line bg-surface px-2 py-1.5 text-[13px] text-ink outline-none focus:border-series-1"
          >
            <option value="">Select…</option>
            {strikeOptions.map((k) => (
              <option key={k} value={k}>{fmtPrice(k, k % 1 ? 1 : 0)}</option>
            ))}
          </select>
        </div>

        <div>
          <span className="block text-[12px] text-ink-2">Side</span>
          <div className="mt-1 flex rounded-md border border-line p-0.5">
            {(["long", "short"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSide(s)}
                className={`rounded px-2.5 py-1 text-[13px] font-medium transition-colors ${
                  side === s ? (s === "short" ? "bg-good text-white" : "bg-series-1 text-white") : "text-ink-2 hover:text-ink"
                }`}
              >
                {s === "short" ? "Sell" : "Buy"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor={`${id}-contracts`} className="block text-[12px] text-ink-2">Contracts</label>
          <input
            id={`${id}-contracts`}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={contracts}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (Number.isFinite(v) && v >= 1) setContracts(v);
            }}
            className="mt-1 w-16 rounded-md border border-line bg-surface px-2 py-1.5 text-[13px] tabular-nums text-ink outline-none focus:border-series-1 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
        </div>

        <button
          type="button"
          disabled={strike === null || draftPrice === null}
          title={strike !== null && draftPrice === null ? "No live quote for this contract" : undefined}
          onClick={() => {
            if (strike === null) return;
            setLegs((prev) => [...prev, { expiry, optionType, strike, side, contracts }]);
          }}
          className="rounded-md border border-line px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:border-series-1 hover:text-series-1 disabled:cursor-not-allowed disabled:opacity-40"
        >
          + Add leg
        </button>
      </div>

      {legs.length > 0 && (
        <div className="border-t border-line px-5 py-4 sm:px-6">
          <table className="w-full text-[13px] tabular-nums">
            <caption className="sr-only">Legs of this custom strategy</caption>
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-muted">
                <th scope="col" className="py-1.5 font-normal">Leg</th>
                <th scope="col" className="py-1.5 font-normal">Expiry</th>
                <th scope="col" className="py-1.5 text-right font-normal">Contracts</th>
                <th scope="col" className="py-1.5 text-right font-normal">Price</th>
                <th scope="col" className="py-1.5 pr-0 text-right font-normal"></th>
              </tr>
            </thead>
            <tbody className="text-ink-2">
              {priced.map(({ leg, price }, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  <td className="py-1.5 text-ink">
                    <span className={leg.side === "short" ? "text-good" : "text-series-1"}>
                      {leg.side === "short" ? "Sell" : "Buy"}
                    </span>{" "}
                    {symbol} {fmtPrice(leg.strike, leg.strike % 1 ? 1 : 0)} {leg.optionType === "CE" ? "call" : "put"}
                  </td>
                  <td className="py-1.5">{fmtExpiry(leg.expiry)}</td>
                  <td className="py-1.5 text-right">{leg.contracts}</td>
                  <td className="py-1.5 text-right">{price === null ? "no quote" : fmtPrice(price)}</td>
                  <td className="py-1.5 pr-0 text-right">
                    <button
                      type="button"
                      onClick={() => setLegs((prev) => prev.filter((_, j) => j !== i))}
                      aria-label="Remove leg"
                      className="text-[12px] text-muted hover:text-critical"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[12px] text-ink-2">{netCash >= 0 ? "Net credit" : "Net debit"}</div>
              <div className="text-lg font-semibold tabular-nums text-ink">{fmtPrice(Math.abs(netCash))}</div>
            </div>
            <button
              type="button"
              disabled={!ready}
              title={ready ? undefined : "A current quote is missing for one or more legs"}
              onClick={() => {
                if (!ready) return;
                enterPositions(
                  priced.map(({ leg, price }) => ({
                    symbol,
                    optionType: leg.optionType,
                    strike: leg.strike,
                    expiry: leg.expiry,
                    side: leg.side,
                    contracts: leg.contracts,
                    entryPremium: price!,
                    entrySpot: spot,
                    entryVol: volFor(svi, leg.expiry, leg.strike) ?? undefined,
                  })),
                );
                setEntered(true);
              }}
              className="rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-surface transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Enter {fmtInt(legs.length)}-leg strategy
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
