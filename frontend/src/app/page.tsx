import Link from "next/link";

import { ColumnChart, type Column } from "@/components/charts/ColumnChart";
import { PositionsList } from "@/components/positions/PositionsList";
import { Card, CardHeader, EmptyState, PIPELINE_COMMAND, TableView } from "@/components/ui";
import { expiryKey, loadArbSummary, loadIv, loadMeta, loadQuotes, loadRegime, loadSvi } from "@/lib/data";
import { daysToExpiry, fmtExpiry, fmtInt, fmtPct, fmtPrice, fmtVolPts } from "@/lib/format";
import { median } from "@/lib/scale";

export default async function OverviewPage() {
  const [meta, summary, iv, quotes, svi, regime] = await Promise.all([
    loadMeta(), loadArbSummary(), loadIv(), loadQuotes(), loadSvi(), loadRegime(),
  ]);
  if (!meta) return <EmptyState title="No snapshot yet." command={PIPELINE_COMMAND} />;

  // Median bid-ask width in vol terms, per expiry: what crossing the spread costs.
  const byExpiry = new Map<string, number[]>();
  for (const r of iv ?? []) {
    if (r.iv_bid == null || r.iv_ask == null) continue;
    const k = expiryKey(r.expiry);
    byExpiry.set(k, [...(byExpiry.get(k) ?? []), r.iv_ask - r.iv_bid]);
  }
  const spreadCols: Column[] = [...byExpiry.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, xs]) => {
      const dte = daysToExpiry(k, meta.fetchedAt);
      return { key: k, label: `${dte}d`, detail: `${fmtExpiry(k)} · ${dte} DTE · ${xs.length} strikes`, value: median(xs) };
    });

  const total = summary?.total;
  const surviveShare = total && total.violations > 0 ? total.survive / total.violations : null;

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm text-muted">Phase 2 · Arbitrage checker with costs</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">Does the edge survive costs?</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-ink-2">
          Every butterfly and calendar condition on the {meta.symbol} quote surface, checked at mid, then again
          with every leg crossed — bought at the ask, sold at the bid — and every leg&apos;s broker commission paid.
        </p>
      </div>

      {total ? (
        <Card className="px-6 py-7">
          <div className="text-7xl font-semibold tracking-tight text-ink sm:text-8xl">{fmtInt(total.survive)}</div>
          <div className="mt-2 text-lg text-ink-2">violations survive costs</div>
          <p className="mt-4 max-w-xl text-sm leading-6 text-ink-2">
            of <span className="font-medium text-ink">{fmtInt(total.violations)}</span> found at mid (
            {fmtPct(surviveShare)}), across {fmtInt(total.checked)} checks, spread and{" "}
            {fmtPrice(summary.commission_per_contract)}/contract commission included. The prediction was close to
            zero.
          </p>
          <Link href="/arbitrage" className="mt-4 inline-block text-sm font-medium text-series-1 hover:underline">
            Inspect the violations →
          </Link>
        </Card>
      ) : (
        <EmptyState title="No arbitrage results yet." command={PIPELINE_COMMAND} />
      )}

      {quotes && (
        <div>
          <h2 className="mb-3 text-lg font-semibold tracking-tight text-ink">Your positions</h2>
          <PositionsList quotes={quotes} iv={iv ?? []} svi={svi ?? []} regime={regime} spot={meta.underlying} fetchedAt={meta.fetchedAt} />
        </div>
      )}

      {spreadCols.length > 0 && (
        <Card>
          <CardHeader
            title="What crossing the spread costs, in vol"
            description="Median of ask IV minus bid IV per strike, by days to expiry."
          />
          <div className="px-3 pt-4 pb-2 sm:px-4">
            <ColumnChart
              data={spreadCols}
              label="Median bid-ask implied-volatility width by days to expiry"
              unit="volPts"
            />
            <p className="px-2 pb-2 text-[11px] text-muted">Vol points · days to expiry</p>
          </div>
          <TableView
            caption="Median bid-ask IV width by expiry"
            head={["Expiry", "Days", "Strikes", "Median width"]}
            rows={spreadCols.map((c) => [fmtExpiry(c.key), c.label, fmtInt(byExpiry.get(c.key)?.length), fmtVolPts(c.value)])}
          />
        </Card>
      )}
    </div>
  );
}
