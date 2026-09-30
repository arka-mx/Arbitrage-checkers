import type { Metadata } from "next";

import { StackedBarChart, type StackRow } from "@/components/charts/StackedBarChart";
import { Pagination } from "@/components/Pagination";
import { EnterArbitrage } from "@/components/positions/EnterArbitrage";
import { Segmented, withParams } from "@/components/Segmented";
import { Card, CardHeader, EmptyState, PIPELINE_COMMAND, StatTile, TableView } from "@/components/ui";
import { expiryKey, loadArbSummary, loadMeta, loadQuotes, loadViolations, type Violation } from "@/lib/data";
import { fmtExpiry, fmtInt, fmtPct, fmtPrice } from "@/lib/format";

export const metadata: Metadata = { title: "Arbitrage" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const PAGE_SIZE = 30;

const BUCKETS = [
  { key: "deepOtm", label: "Deep OTM", test: (m: number) => m < -0.1 },
  { key: "otm", label: "OTM", test: (m: number) => m >= -0.1 && m < -0.03 },
  { key: "atm", label: "Near ATM ±3%", test: (m: number) => Math.abs(m) < 0.03 },
  { key: "itm", label: "ITM", test: (m: number) => m >= 0.03 && m <= 0.1 },
  { key: "deepItm", label: "Deep ITM", test: (m: number) => m > 0.1 },
] as const;

/** Signed moneyness of the (middle) strike: > 0 means in the money for that option type. */
function moneyness(v: Violation, spot: number) {
  const lm = Math.log((v.k2 ?? v.k1) / spot);
  return v.option_type === "CE" ? -lm : lm;
}
const bucketOf = (v: Violation, spot: number) => BUCKETS.find((b) => b.test(moneyness(v, spot)))!;

function Status({ survives }: { survives: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={`size-2 rounded-full ${survives ? "bg-series-1" : "bg-neutral-fill"}`} />
      {survives ? "Survives" : "Eaten by costs"}
    </span>
  );
}

export default async function ArbitragePage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, meta, summary, violations, quotes] = await Promise.all([searchParams, loadMeta(), loadArbSummary(), loadViolations(), loadQuotes()]);
  if (!meta || !summary || !violations) return <EmptyState title="No arbitrage results yet." command={PIPELINE_COMMAND} />;

  const kind = (["butterfly", "calendar"] as const).find((k) => k === one(sp.kind)) ?? "all";
  const show = one(sp.show) === "all" ? "all" : "survivors";
  const current = { kind, show, page: "1" };
  const spot = summary.meta.underlying ?? meta.underlying;

  const ofKind = violations.filter((v) => kind === "all" || v.kind === kind);
  const chartRows: StackRow[] = BUCKETS.map((b) => {
    const inB = ofKind.filter((v) => bucketOf(v, spot).key === b.key);
    const survive = inB.filter((v) => v.survives).length;
    return {
      key: b.key,
      label: b.label,
      values: { survive, eaten: inB.length - survive },
      endLabel: `${fmtInt(survive)} of ${fmtInt(inB.length)}`,
    };
  });

  const top = [...chartRows].sort((a, b) => b.values.survive - a.values.survive)[0];
  const totalSurvive = chartRows.reduce((n, r) => n + r.values.survive, 0);

  const listed = ofKind
    .filter((v) => show === "all" || v.survives)
    .sort((a, b) => (show === "all" ? a.mid_value - b.mid_value : a.exec_value - b.exec_value));
  const totalPages = Math.max(1, Math.ceil(listed.length / PAGE_SIZE));
  const pageNum = Math.min(totalPages, Math.max(1, Number(one(sp.page)) || 1));
  const pageItems = listed.slice((pageNum - 1) * PAGE_SIZE, pageNum * PAGE_SIZE);
  const t = summary.total;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Arbitrage checker</h1>
        <p className="mt-1 max-w-2xl text-[14px] leading-6 text-ink-2">
          <span className="text-ink">Butterfly</span>: prices must be convex in strike.{" "}
          <span className="text-ink">Calendar</span>: a longer-dated option can&apos;t be worth less than a shorter one
          at the same strike. Both are model-free for SPY&apos;s American options. A violation fails at mid; it survives
          if it still fails with every leg bought at the ask and sold at the bid, and every leg&apos;s commission paid.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <StatTile label="Checks run" value={fmtInt(t.checked)} detail={`${fmtInt(summary.butterfly.checked)} butterflies · ${fmtInt(summary.calendar.checked)} calendars`} />
        <StatTile label="Violations at mid" value={fmtInt(t.violations)} detail={`${fmtPct(t.violations / t.checked)} of checks`} />
        <StatTile label="Survive costs" value={fmtInt(t.survive)} detail={`${fmtPct(t.survive / t.violations)} of violations`} />
        <StatTile label="Commission" value={`${fmtPrice(summary.commission_per_contract)}/contract`} detail="charged on every leg, each side of the trade" />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Segmented
          label="Check"
          value={kind}
          hrefFor={(v) => withParams("/arbitrage", current, { kind: v, page: "1" })}
          options={[
            { value: "all", label: "All checks" },
            { value: "butterfly", label: "Butterfly", hint: fmtInt(summary.butterfly.violations) },
            { value: "calendar", label: "Calendar", hint: fmtInt(summary.calendar.violations) },
          ]}
        />
        <Segmented
          label="Violations shown"
          value={show}
          hrefFor={(v) => withParams("/arbitrage", current, { show: v, page: "1" })}
          options={[
            { value: "survivors", label: "Survivors" },
            { value: "all", label: "All violations" },
          ]}
        />
      </div>

      <Card>
        <CardHeader
          title="Where the violations sit"
          description={
            totalSurvive > 0
              ? `By moneyness of the (middle) strike against spot. Real edge would cluster near the money, where SPY trades most. The largest group of survivors is ${top.label} (${fmtInt(top.values.survive)} of ${fmtInt(totalSurvive)}).`
              : "By moneyness of the (middle) strike against spot. No violations survive costs in this selection."
          }
        />
        <ul className="flex gap-x-5 px-5 pt-3 text-[12px] text-ink-2 sm:px-6">
          <li className="flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm bg-series-1" />Survives costs</li>
          <li className="flex items-center gap-1.5"><span aria-hidden className="size-2.5 rounded-sm bg-neutral-fill" />Eaten by costs</li>
        </ul>
        <div className="px-3 pt-2 pb-3 sm:px-4">
          <StackedBarChart
            rows={chartRows}
            series={[
              { key: "survive", label: "Survives costs", color: "var(--series-1)" },
              { key: "eaten", label: "Eaten by costs", color: "var(--neutral-fill)" },
            ]}
            label="Violations by moneyness, split into those that survive costs and those eaten by costs"
          />
        </div>
        <TableView
          caption="Violations by moneyness"
          head={["Moneyness", "Violations", "Survive", "Share surviving"]}
          rows={chartRows.map((r) => {
            const n = r.values.survive + r.values.eaten;
            return [r.label, fmtInt(n), fmtInt(r.values.survive), n ? fmtPct(r.values.survive / n) : "—"];
          })}
        />
      </Card>

      <Card>
        <CardHeader
          title={show === "survivors" ? "Survivors, largest edge first" : "All violations, largest at mid first"}
          description={`Values are the price of a position whose payoff can't be negative, per share. Below zero means you'd be paid to hold it. "After costs" already includes ${fmtPrice(summary.commission_per_contract)}/contract commission on every leg. Survivors can be entered below as their full multi-leg strategy at the quoted bid/ask. Quote skew is the gap between the oldest and newest leg quote: stale legs make fake arbitrage.`}
        />
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[980px] text-[13px] tabular-nums">
            <caption className="sr-only">{show === "survivors" ? "Violations that survive costs" : "All violations"}</caption>
            <thead>
              <tr className="border-y border-line text-left text-[12px] text-muted">
                <th scope="col" className="py-2 pl-5 font-normal sm:pl-6">Check</th>
                <th scope="col" className="py-2 font-normal">Expiry</th>
                <th scope="col" className="py-2 font-normal">Strikes</th>
                <th scope="col" className="py-2 font-normal">Moneyness</th>
                <th scope="col" className="py-2 text-right font-normal">At mid</th>
                <th scope="col" className="py-2 text-right font-normal">After costs</th>
                <th scope="col" className="py-2 pl-6 font-normal">Status</th>
                <th scope="col" className="py-2 pr-5 text-right font-normal sm:pr-6">Position</th>
                <th scope="col" className="py-2 pr-5 text-right font-normal sm:pr-6">Quote skew</th>
              </tr>
            </thead>
            <tbody className="text-ink-2">
              {pageItems.map((v, i) => (
                <tr key={i} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                  <td className="py-2 pl-5 text-ink sm:pl-6">
                    {v.kind === "butterfly" ? "Butterfly" : "Calendar"}
                    <span className="text-muted"> · {v.option_type === "CE" ? "call" : "put"}</span>
                  </td>
                  <td className="py-2 whitespace-nowrap">
                    {fmtExpiry(expiryKey(v.expiry))}
                    {v.expiry_far && <span className="text-muted"> → {fmtExpiry(expiryKey(v.expiry_far))}</span>}
                  </td>
                  <td className="py-2 whitespace-nowrap">{[v.k1, v.k2, v.k3].filter((k) => k != null).join(" / ")}</td>
                  <td className="py-2 whitespace-nowrap">{bucketOf(v, spot).label}</td>
                  <td className="py-2 text-right">{fmtPrice(v.mid_value, 3)}</td>
                  <td className="py-2 text-right font-medium text-ink">{fmtPrice(v.exec_value, 3)}</td>
                  <td className="py-2 pl-6"><Status survives={v.survives} /></td>
                  <td className="py-2 pr-5 text-right sm:pr-6">
                    {v.survives && quotes ? <EnterArbitrage violation={v} quotes={quotes} symbol={meta.symbol} spot={spot} /> : <span className="text-muted">Unavailable</span>}
                  </td>
                  <td className="py-2 pr-5 text-right sm:pr-6">{v.leg_time_skew_s == null ? "—" : `${v.leg_time_skew_s.toFixed(1)} s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-line px-5 py-3 sm:px-6">
          <Pagination
            page={pageNum}
            pageSize={PAGE_SIZE}
            total={listed.length}
            hrefFor={(p) => withParams("/arbitrage", current, { kind, show, page: String(p) })}
          />
        </div>
      </Card>
    </div>
  );
}
