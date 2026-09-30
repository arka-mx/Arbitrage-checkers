"use client";

import Link from "next/link";
import { useId, useState } from "react";

import { Card, CardHeader } from "@/components/ui";
import type { OptionType } from "@/lib/data";
import { fmtInt, fmtPrice } from "@/lib/format";
import { enterPosition, type Position, type Side } from "@/lib/positions";

const COPY = {
  short: { verb: "Sold", verbing: "Selling", cashLabel: "You'll receive", cta: "Sell to open", color: "bg-good" },
  long: { verb: "Bought", verbing: "Buying", cashLabel: "You'll pay", cta: "Buy to open", color: "bg-series-1" },
} as const;

export function EnterPosition({
  symbol, optionType, strike, expiry, expiryLabel, side, spot, vol, price,
}: {
  symbol: string; optionType: OptionType; strike: number; expiry: string; expiryLabel: string;
  side: Side; spot: number; vol: number; price: number | null;
}) {
  const id = useId();
  const [contracts, setContracts] = useState(1);
  const [entered, setEntered] = useState<Position | null>(null);
  const label = optionType === "CE" ? "call" : "put";
  const copy = COPY[side];

  if (entered) {
    const entryCopy = COPY[entered.side];
    return (
      <Card className="border-good/30 px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-good text-white">✓</span>
            <p className="text-[14px] text-ink">
              {entryCopy.verb} {entered.contracts} × {symbol} {fmtPrice(entered.strike, entered.strike % 1 ? 1 : 0)} {label} exp{" "}
              {expiryLabel} for <span className="font-semibold tabular-nums">{fmtPrice(entered.entryPremium * 100 * entered.contracts)}</span>.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setEntered(null)} className="text-[13px] text-ink-2 hover:text-ink">
              Enter another
            </button>
            <Link
              href="/"
              className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-surface transition-opacity hover:opacity-90"
            >
              View on Overview →
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Enter position"
        description={`${copy.verbing} at the current market ${side === "short" ? "bid" : "ask"} and saves it to your positions, tracked in this browser.`}
      />
      <div className="flex flex-wrap items-end gap-4 px-5 py-4 sm:px-6">
        <div>
          <label htmlFor={id} className="block text-[12px] text-ink-2">Contracts</label>
          <div className="mt-1 flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 focus-within:border-series-1">
            <input
              id={id}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={contracts}
              onChange={(e) => {
                const v = Math.round(Number(e.target.value));
                if (Number.isFinite(v) && v >= 1) setContracts(v);
              }}
              className="w-16 bg-transparent text-sm tabular-nums text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
          </div>
        </div>

        <div className="flex-1">
          <div className="text-[12px] text-ink-2">{copy.cashLabel}</div>
          <div className="text-lg font-semibold tabular-nums text-ink">
            {price === null ? "—" : fmtPrice(price * 100 * contracts)}
          </div>
          <div className="text-[11px] text-muted">{price === null ? "no live quote for this contract" : `${fmtPrice(price)}/share × 100 × ${fmtInt(contracts)}`}</div>
        </div>

        <button
          type="button"
          disabled={price === null}
          onClick={() =>
            setEntered(
              enterPosition({
                symbol, optionType, strike, expiry, side, contracts,
                entryPremium: price!, entrySpot: spot, entryVol: vol,
              }),
            )
          }
          className={`rounded-md px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 ${copy.color}`}
        >
          {copy.cta}
        </button>
      </div>
    </Card>
  );
}
