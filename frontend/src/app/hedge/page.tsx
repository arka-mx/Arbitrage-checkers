import type { Metadata } from "next";
import Link from "next/link";

import { HedgeSimulator } from "@/components/hedge/HedgeSimulator";
import { EnterPosition } from "@/components/positions/EnterPosition";
import { Card, EmptyState, PIPELINE_COMMAND } from "@/components/ui";
import { expiryKey, loadIv, loadMeta, loadQuotes, loadSvi, type OptionType } from "@/lib/data";
import { daysToExpiry, fmtExpiry, fmtPrice } from "@/lib/format";
import type { Side } from "@/lib/positions";
import { sviImpliedVol } from "@/lib/svi";

export const metadata: Metadata = { title: "Hedge" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function HedgePage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, meta, quotes, iv, svi] = await Promise.all([
    searchParams, loadMeta(), loadQuotes(), loadIv(), loadSvi(),
  ]);
  if (!meta || !quotes || !iv || !svi) return <EmptyState title="No snapshot yet." command={PIPELINE_COMMAND} />;

  const expiry = one(sp.expiry);
  const strike = Number(one(sp.strike));
  const type = one(sp.type);
  const optionType: OptionType | null = type === "CE" || type === "PE" ? type : null;
  const side: Side = one(sp.side) === "long" ? "long" : "short";

  const fit = svi.find((f) => expiryKey(f.expiry) === expiry);
  const hasSelection = expiry !== undefined && Number.isFinite(strike) && strike > 0 && optionType !== null;

  if (!hasSelection || !fit) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Trade an option</h1>
          <p className="mt-1 max-w-2xl text-[14px] leading-6 text-ink-2">
            Pick a contract to buy or sell, then delta-hedge it under different rebalancing rules and see what the
            bid-ask cost of hedging actually adds up to.
          </p>
        </div>
        <Card className="px-6 py-10 text-center">
          <p className="text-sm text-ink">
            {hasSelection ? "No fitted volatility for that expiry yet." : "No option selected."}
          </p>
          <p className="mt-2 text-[13px] text-ink-2">
            Go to the chain and click <span className="font-medium text-ink">Buy</span> or{" "}
            <span className="font-medium text-ink">Sell</span> on a call or put.
          </p>
          <Link
            href="/chain"
            className="mt-4 inline-block rounded-md border border-line px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:border-series-1 hover:text-series-1"
          >
            Go to option chain →
          </Link>
        </Card>
      </div>
    );
  }

  const quote = quotes.find(
    (q) => expiryKey(q.expiry) === expiry && q.strike === strike && q.option_type === optionType,
  );
  const spot = meta.underlying;
  const vol = sviImpliedVol(fit, strike, fit.forward, fit.time_to_expiry);
  const dte = daysToExpiry(expiry, meta.fetchedAt);
  const label = optionType === "CE" ? "call" : "put";
  const tradePrice = side === "short" ? (quote?.bid ?? null) : (quote?.ask ?? null);

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[13px] text-muted">Phase 3 · Delta-hedging simulator with costs</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {side === "short" ? "Sell" : "Buy"} the {meta.symbol} {fmtPrice(strike, strike % 1 ? 1 : 0)} {label}
        </h1>
        <p className="mt-1 max-w-2xl text-[14px] leading-6 text-ink-2">
          Expiring {fmtExpiry(expiry)} · {dte} DTE. Delta-hedge it under different rebalancing rules, paying half
          the underlying&apos;s bid-ask spread on every trade, and see where total cost bottoms out.
        </p>
      </div>

      <Card>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4 px-5 py-5 sm:grid-cols-4 sm:px-6">
          <div>
            <dt className="text-[12px] text-ink-2">Market {side === "short" ? "bid" : "ask"}</dt>
            <dd className="text-lg font-semibold tabular-nums text-ink">{tradePrice === null ? "—" : fmtPrice(tradePrice)}</dd>
            <dd className="text-[11px] text-muted">{side === "short" ? "what you'd actually receive" : "what you'd actually pay"}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-ink-2">Spot</dt>
            <dd className="text-lg font-semibold tabular-nums text-ink">{fmtPrice(spot)}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-ink-2">Vol used</dt>
            <dd className="text-lg font-semibold tabular-nums text-ink">{(vol * 100).toFixed(1)}%</dd>
            <dd className="text-[11px] text-muted">this strike&apos;s SVI-fitted IV</dd>
          </div>
          <div>
            <dt className="text-[12px] text-ink-2">Days to expiry</dt>
            <dd className="text-lg font-semibold tabular-nums text-ink">{dte}</dd>
          </div>
        </dl>
        <p className="border-t border-line px-5 py-3 text-[12px] leading-4 text-ink-2 sm:px-6">
          The simulator prices and hedges under Black-Scholes with r=0, q=0 (a deliberate simplification for a
          days-to-weeks option) using the vol above for both the simulated path and the hedge ratio — it doesn&apos;t
          model being wrong about volatility, only the cost of not hedging continuously.
        </p>
      </Card>

      <EnterPosition
        symbol={meta.symbol}
        optionType={optionType}
        strike={strike}
        expiry={expiry}
        expiryLabel={fmtExpiry(expiry)}
        side={side}
        spot={spot}
        vol={vol}
        price={tradePrice}
      />

      <HedgeSimulator
        symbol={meta.symbol}
        strike={strike}
        optionType={optionType}
        expiryLabel={fmtExpiry(expiry)}
        side={side}
        spot={spot}
        timeToExpiry={fit.time_to_expiry}
        initialVol={vol}
      />
    </div>
  );
}
