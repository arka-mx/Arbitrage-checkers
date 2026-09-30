"use client";

import Link from "next/link";
import { Fragment, useState } from "react";

import { PayoffProjectionChart } from "@/components/charts/PayoffProjectionChart";
import { Card, CardHeader, StatTile } from "@/components/ui";
import type { IvRow, Quote, RegimeSummary, SviRow } from "@/lib/data";
import { daysToExpiry, expiryKey, fmtExpiry, fmtInt, fmtPct, fmtPrice } from "@/lib/format";
import { daysFromNow, projectStrategyPayoff, regimeAssumption, type PayoffLeg } from "@/lib/payoff";
import {
  closePosition, closingQuoteField, deletePosition, pnlPerShare, reopenPosition, usePositions, type Position,
} from "@/lib/positions";
import { sviImpliedVol } from "@/lib/svi";

function pnlClass(v: number | null) {
  if (v === null) return "text-ink-2";
  return v > 0 ? "text-good" : v < 0 ? "text-critical" : "text-ink-2";
}

function totalPnl(p: Position, perShare: number | null) {
  return perShare === null ? null : perShare * 100 * p.contracts;
}

function CloseControl({ position, marketClose }: { position: Position; marketClose: number | null }) {
  const [price, setPrice] = useState(marketClose !== null ? String(marketClose) : "");
  const parsed = Number(price);
  const valid = Number.isFinite(parsed) && parsed >= 0 && price !== "";

  return (
    <div className="flex items-center justify-end gap-1.5">
      <div className="flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1">
        <span className="text-[11px] text-muted">$</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step={0.01}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder={marketClose === null ? "price" : undefined}
          className="w-16 bg-transparent text-right text-[13px] tabular-nums text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
      </div>
      <button
        type="button"
        disabled={!valid}
        onClick={() => closePosition(position.id, parsed)}
        className="rounded-md border border-line px-2 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:border-series-1 hover:text-series-1 disabled:opacity-40"
      >
        Close
      </button>
    </div>
  );
}

/** Live vol at a strike, preferring the cleaned IV surface, then the fitted
 *  SVI smile (which extrapolates to any strike, unlike the raw surface —
 *  good enough for thin/crossed-quote strikes an arbitrage violation lives
 *  at), then the vol implied by whatever price was actually paid at entry. */
function volFor(iv: IvRow[], svi: SviRow[], expiry: string, strike: number, entryVol: number | undefined): number | null {
  const row = iv.find((r) => expiryKey(r.expiry) === expiry && r.strike === strike && r.iv_mid != null);
  if (row) return row.iv_mid;
  const fit = svi.find((f) => expiryKey(f.expiry) === expiry);
  if (fit) return sviImpliedVol(fit, strike, fit.forward, fit.time_to_expiry);
  return entryVol ?? null;
}

type OpenRow = { position: Position; quote: Quote | undefined; mark: number | null; perShare: number | null; total: number | null };

function PayoffPanel({ group, spot, iv, svi, regime }: { group: OpenRow[]; spot: number; iv: IvRow[]; svi: SviRow[]; regime: RegimeSummary | null }) {
  const [now] = useState(() => Date.now());
  const livePnLNow = group.reduce((s, r) => s + (r.total ?? 0), 0);
  const legs: PayoffLeg[] = group.map((r) => ({
    strike: r.position.strike,
    optionType: r.position.optionType,
    side: r.position.side,
    contracts: r.position.contracts,
    expiry: r.position.expiry,
    vol: volFor(iv, svi, r.position.expiry, r.position.strike, r.position.entryVol),
  }));
  const maxDays = Math.max(...group.map((r) => daysFromNow(r.position.expiry, now)));
  const assumption = regimeAssumption(regime);
  const series = maxDays > 0 ? projectStrategyPayoff(legs, livePnLNow, spot, now, maxDays, assumption) : null;

  return (
    <details className="group">
      <summary className="cursor-pointer list-none select-none py-2 text-[12px] text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <span className="inline-block transition-transform group-open:rotate-90">›</span> Payoff projection to expiry
        {group.length > 1 ? ` (${group.length} legs, combined)` : ""}
      </summary>
      <div className="pb-3">
        {series ? (
          <>
            <PayoffProjectionChart
              series={series}
              label="Projected profit and loss from today to expiry, from a Monte Carlo simulation under the current realized-volatility regime"
            />
            <p className="px-1 pt-1 text-[11px] leading-4 text-muted">
              {assumption
                ? `Spot simulated under the current "${assumption.label}" realized-vol regime (${fmtPct(assumption.volAnnual)} annualized, from ~2y of daily bars); each leg repriced at its own live implied vol.`
                : "Regime data unavailable — falling back to a flat assumption: spot held at today's level, only time passing."}
            </p>
          </>
        ) : (
          <p className="px-1 py-2 text-[12px] text-muted">No live implied volatility for this strike right now — can&apos;t project.</p>
        )}
      </div>
    </details>
  );
}

function SideTag({ side }: { side: Position["side"] }) {
  return (
    <span
      className={`rounded px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        side === "short" ? "bg-good/15 text-good" : "bg-series-1/15 text-series-1"
      }`}
    >
      {side}
    </span>
  );
}

export function PositionsList({
  quotes, iv, svi, regime, spot, fetchedAt,
}: {
  quotes: Quote[]; iv: IvRow[]; svi: SviRow[]; regime: RegimeSummary | null; spot: number; fetchedAt: string;
}) {
  const positions = usePositions();
  const open = positions.filter((p) => p.status === "open");
  const closed = positions.filter((p) => p.status === "closed");

  const quoteFor = (p: Position) =>
    quotes.find((q) => expiryKey(q.expiry) === p.expiry && q.strike === p.strike && q.option_type === p.optionType);

  const openRows: OpenRow[] = open.map((p) => {
    const quote = quoteFor(p);
    const mark = quote?.[closingQuoteField(p.side)] ?? null;
    const perShare = pnlPerShare(p, mark);
    return { position: p, quote, mark, perShare, total: totalPnl(p, perShare) };
  });

  const groupOrder: string[] = [];
  const groups = new Map<string, OpenRow[]>();
  for (const row of openRows) {
    const key = row.position.strategyId;
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key)!.push(row);
  }

  if (positions.length === 0) {
    return (
      <Card className="px-6 py-10 text-center">
        <p className="text-sm text-ink">No positions yet.</p>
        <p className="mt-2 text-[13px] text-ink-2">
          Go to the chain, click <span className="font-medium text-ink">Buy</span> or{" "}
          <span className="font-medium text-ink">Sell</span> on a call or put, then enter the position.
        </p>
        <Link
          href="/chain"
          className="mt-4 inline-block rounded-md border border-line px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:border-series-1 hover:text-series-1"
        >
          Go to option chain →
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3">
        <StatTile label="Open positions" value={fmtInt(open.length)} />
      </div>

      <Card>
        <CardHeader title="Open" description="Marked to what it would cost to close each one right now: the ask for a short, the bid for a long." />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[13px] tabular-nums">
            <thead>
              <tr className="border-y border-line text-left text-[12px] text-muted">
                <th scope="col" className="py-2 pl-5 font-normal sm:pl-6">Position</th>
                <th scope="col" className="py-2 font-normal">Expiry</th>
                <th scope="col" className="py-2 text-right font-normal">Contracts</th>
                <th scope="col" className="py-2 text-right font-normal">Entry</th>
                <th scope="col" className="py-2 text-right font-normal">Mark</th>
                <th scope="col" className="py-2 text-right font-normal">P&amp;L</th>
                <th scope="col" className="py-2 pr-5 text-right font-normal sm:pr-6">Close</th>
              </tr>
            </thead>
            <tbody className="text-ink-2">
              {groupOrder.map((key) => {
                const group = groups.get(key)!;
                return (
                  <Fragment key={key}>
                    {group.map(({ position: p, mark, total }) => (
                      <tr key={p.id} className="border-b border-line last:border-0">
                        <td className="py-2 pl-5 text-ink sm:pl-6">
                          <div className="flex items-center gap-1.5">
                            <Link href={`/hedge?expiry=${p.expiry}&strike=${p.strike}&type=${p.optionType}&side=${p.side}`} className="hover:text-series-1">
                              {p.symbol} {fmtPrice(p.strike, p.strike % 1 ? 1 : 0)} {p.optionType === "CE" ? "call" : "put"}
                            </Link>
                            <SideTag side={p.side} />
                          </div>
                        </td>
                        <td className="py-2 whitespace-nowrap">
                          {fmtExpiry(p.expiry)} <span className="text-muted">· {daysToExpiry(p.expiry, fetchedAt)}d</span>
                        </td>
                        <td className="py-2 text-right">{p.contracts}</td>
                        <td className="py-2 text-right">{fmtPrice(p.entryPremium)}</td>
                        <td className="py-2 text-right">{mark === null ? "—" : fmtPrice(mark)}</td>
                        <td className={`py-2 text-right font-medium ${pnlClass(total)}`}>{total === null ? "no quote" : fmtPrice(total)}</td>
                        <td className="py-2 pr-5 sm:pr-6">
                          <div className="flex items-center justify-end gap-3">
                            <CloseControl position={p} marketClose={mark} />
                            <button type="button" onClick={() => deletePosition(p.id)} aria-label="Remove position" className="text-[12px] text-muted hover:text-critical">
                              ✕
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    <tr className="border-b border-line last:border-0 bg-surface-2/40">
                      <td colSpan={7} className="px-5 sm:px-6">
                        <PayoffPanel group={group} spot={spot} iv={iv} svi={svi} regime={regime} />
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
              {openRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-ink-2">No open positions.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {closed.length > 0 && (
        <Card>
          <CardHeader title="Closed" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[13px] tabular-nums">
              <thead>
                <tr className="border-y border-line text-left text-[12px] text-muted">
                  <th scope="col" className="py-2 pl-5 font-normal sm:pl-6">Position</th>
                  <th scope="col" className="py-2 font-normal">Expiry</th>
                  <th scope="col" className="py-2 text-right font-normal">Entry</th>
                  <th scope="col" className="py-2 text-right font-normal">Close</th>
                  <th scope="col" className="py-2 text-right font-normal">P&amp;L</th>
                  <th scope="col" className="py-2 pr-5 text-right font-normal sm:pr-6"></th>
                </tr>
              </thead>
              <tbody className="text-ink-2">
                {closed.map((p) => {
                  const perShare = pnlPerShare(p, null);
                  const total = totalPnl(p, perShare);
                  return (
                    <tr key={p.id} className="border-b border-line last:border-0">
                      <td className="py-2 pl-5 text-ink sm:pl-6">
                        <div className="flex items-center gap-1.5">
                          <span>
                            {p.symbol} {fmtPrice(p.strike, p.strike % 1 ? 1 : 0)} {p.optionType === "CE" ? "call" : "put"}
                            <span className="text-muted"> ×{p.contracts}</span>
                          </span>
                          <SideTag side={p.side} />
                        </div>
                      </td>
                      <td className="py-2 whitespace-nowrap">{fmtExpiry(p.expiry)}</td>
                      <td className="py-2 text-right">{fmtPrice(p.entryPremium)}</td>
                      <td className="py-2 text-right">{fmtPrice(p.closePremium ?? 0)}</td>
                      <td className={`py-2 text-right font-medium ${pnlClass(total)}`}>{fmtPrice(total ?? 0)}</td>
                      <td className="py-2 pr-5 sm:pr-6">
                        <div className="flex items-center justify-end gap-3">
                          <button type="button" onClick={() => reopenPosition(p.id)} className="text-[12px] text-ink-2 hover:text-series-1">
                            Reopen
                          </button>
                          <button type="button" onClick={() => deletePosition(p.id)} aria-label="Remove position" className="text-[12px] text-muted hover:text-critical">
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
