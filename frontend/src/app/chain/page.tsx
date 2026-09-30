import type { Metadata } from "next";
import Link from "next/link";

import { Segmented, withParams } from "@/components/Segmented";
import { CustomStrategyBuilder } from "@/components/positions/CustomStrategyBuilder";
import { Card, EmptyState, PIPELINE_COMMAND } from "@/components/ui";
import { expiryKey, loadMeta, loadQuotes, loadSvi, type Quote } from "@/lib/data";
import { daysToExpiry, fmtExpiry, fmtPct, fmtPrice } from "@/lib/format";

export const metadata: Metadata = { title: "Chain" };

const NEAR_BAND = 0.05; // ±5% of spot

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

function TradeLink({ q, side }: { q: Quote; side: "short" | "long" }) {
  const href = `/hedge?expiry=${expiryKey(q.expiry)}&strike=${q.strike}&type=${q.option_type}&side=${side}`;
  const label = side === "short" ? "Sell" : "Buy";
  const price = side === "short" ? q.bid : q.ask;
  return (
    <Link
      href={href}
      aria-label={`${label} ${q.option_type === "CE" ? "call" : "put"}, strike ${q.strike}, expiring ${expiryKey(q.expiry)}, ${side === "short" ? "bid" : "ask"} ${fmtPrice(price)}`}
      className={`block whitespace-nowrap rounded-md border border-line px-1.5 py-1 text-center text-[11px] font-medium transition-colors hover:bg-surface-2 ${
        side === "short" ? "text-good hover:border-good" : "text-series-1 hover:border-series-1"
      }`}
    >
      {label}
    </Link>
  );
}

function TradeLinks({ q }: { q: Quote }) {
  return (
    <div className="flex gap-1">
      <TradeLink q={q} side="long" />
      <TradeLink q={q} side="short" />
    </div>
  );
}

/** Calls read left-to-right toward the strike (Bid…Buy/Sell); puts mirror it
 *  (Buy/Sell…Bid), so both action cells land adjacent to the strike column. */
function CallLeg({ q, itm }: { q: Quote | undefined; itm: boolean }) {
  const shade = itm ? "bg-surface-2" : "";
  if (!q) {
    return (
      <>
        {[0, 1, 2, 3].map((i) => (
          <td key={i} className={`px-3 py-1.5 text-right text-muted ${shade}`}>—</td>
        ))}
        <td className={shade} />
      </>
    );
  }
  return (
    <>
      <td className={`px-3 py-1.5 text-right ${shade}`}>{fmtPrice(q.bid)}</td>
      <td className={`px-3 py-1.5 text-right font-medium text-ink ${shade}`}>{fmtPrice(q.mid, 3)}</td>
      <td className={`px-3 py-1.5 text-right ${shade}`}>{fmtPrice(q.ask)}</td>
      <td className={`px-3 py-1.5 text-right text-muted ${shade}`}>{fmtPct(q.spread_pct)}</td>
      <td className={`py-1 pr-2 pl-1 ${shade}`}><TradeLinks q={q} /></td>
    </>
  );
}

function PutLeg({ q, itm }: { q: Quote | undefined; itm: boolean }) {
  const shade = itm ? "bg-surface-2" : "";
  if (!q) {
    return (
      <>
        <td className={shade} />
        {[0, 1, 2, 3].map((i) => (
          <td key={i} className={`px-3 py-1.5 text-right text-muted ${shade}`}>—</td>
        ))}
      </>
    );
  }
  return (
    <>
      <td className={`py-1 pr-1 pl-2 ${shade}`}><TradeLinks q={q} /></td>
      <td className={`px-3 py-1.5 text-right ${shade}`}>{fmtPrice(q.bid)}</td>
      <td className={`px-3 py-1.5 text-right font-medium text-ink ${shade}`}>{fmtPrice(q.mid, 3)}</td>
      <td className={`px-3 py-1.5 text-right ${shade}`}>{fmtPrice(q.ask)}</td>
      <td className={`px-3 py-1.5 text-right text-muted ${shade}`}>{fmtPct(q.spread_pct)}</td>
    </>
  );
}

export default async function ChainPage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, meta, quotes, svi] = await Promise.all([searchParams, loadMeta(), loadQuotes(), loadSvi()]);
  if (!meta || !quotes) return <EmptyState title="No snapshot yet." command={PIPELINE_COMMAND} />;

  const expiry = meta.expiries.includes(one(sp.expiry) ?? "") ? one(sp.expiry)! : meta.expiries[0];
  const range = one(sp.range) === "all" ? "all" : "near";
  const current = { expiry, range };
  const spot = meta.underlying;

  const byStrike = new Map<number, { ce?: Quote; pe?: Quote }>();
  for (const q of quotes) {
    if (expiryKey(q.expiry) !== expiry) continue;
    if (range === "near" && Math.abs(q.strike / spot - 1) > NEAR_BAND) continue;
    const row = byStrike.get(q.strike) ?? {};
    row[q.option_type === "CE" ? "ce" : "pe"] = q;
    byStrike.set(q.strike, row);
  }
  const strikes = [...byStrike.keys()].sort((a, b) => a - b);
  const spotIdx = strikes.findIndex((k) => k >= spot); // divider goes before this row

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Option chain</h1>
        <p className="mt-1 max-w-2xl text-[14px] leading-6 text-ink-2">
          Clean quotes only: missing, zero-bid, and crossed quotes are dropped. Shaded cells are in the money.
        </p>
      </div>

      <CustomStrategyBuilder symbol={meta.symbol} quotes={quotes} svi={svi ?? []} expiries={meta.expiries} spot={spot} />

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Expiry"
          value={expiry}
          hrefFor={(v) => withParams("/chain", current, { expiry: v })}
          options={meta.expiries.map((k) => ({ value: k, label: fmtExpiry(k), hint: `${daysToExpiry(k, meta.fetchedAt)}d` }))}
        />
        <Segmented
          label="Strike range"
          value={range}
          hrefFor={(v) => withParams("/chain", current, { range: v })}
          options={[
            { value: "near", label: "Near the money", hint: "±5%" },
            { value: "all", label: "All strikes" },
          ]}
        />
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-[13px] tabular-nums">
            <caption className="sr-only">
              {meta.symbol} calls and puts expiring {fmtExpiry(expiry)}
            </caption>
            <thead>
              <tr className="border-b border-line text-[12px] text-ink-2">
                <th colSpan={5} scope="colgroup" className="px-3 pt-3 pb-1 text-left font-medium">Calls</th>
                <th className="px-3 pt-3 pb-1" />
                <th colSpan={5} scope="colgroup" className="px-3 pt-3 pb-1 text-right font-medium">Puts</th>
              </tr>
              <tr className="border-b border-line text-[12px] text-muted">
                {["Bid", "Mid", "Ask", "Spread"].map((h) => (
                  <th key={`c${h}`} scope="col" className="px-3 py-1.5 text-right font-normal">{h}</th>
                ))}
                <th scope="col" className="py-1.5" />
                <th scope="col" className="px-3 py-1.5 text-center font-normal text-ink-2">Strike</th>
                <th scope="col" className="py-1.5" />
                {["Bid", "Mid", "Ask", "Spread"].map((h) => (
                  <th key={`p${h}`} scope="col" className="px-3 py-1.5 text-right font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="text-ink-2">
              {strikes.map((k, i) => {
                const row = byStrike.get(k)!;
                return [
                  i === spotIdx && (
                    <tr key="spot" aria-label={`Spot ${fmtPrice(spot)}`}>
                      <td colSpan={11} className="relative h-6 p-0">
                        <div className="absolute inset-x-0 top-1/2 h-px bg-series-1" />
                        <span className="relative mx-auto block w-fit rounded-full bg-series-1 px-2 py-0.5 text-[11px] font-medium text-white">
                          {meta.symbol} {fmtPrice(spot)}
                        </span>
                      </td>
                    </tr>
                  ),
                  <tr key={k} className="border-b border-line last:border-0 hover:[&>td]:bg-surface-2/70">
                    <CallLeg q={row.ce} itm={k < spot} />
                    <th scope="row" className="px-3 py-1.5 text-center font-semibold text-ink">{fmtPrice(k, k % 1 ? 1 : 0)}</th>
                    <PutLeg q={row.pe} itm={k > spot} />
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
        {strikes.length === 0 && <p className="px-6 py-8 text-center text-sm text-ink-2">No clean quotes in this range.</p>}
      </Card>
      <p className="text-[12px] text-muted">
        {strikes.length} strikes · spread shown as a share of mid · quotes as of the {meta.symbol} snapshot in the header
      </p>
    </div>
  );
}
