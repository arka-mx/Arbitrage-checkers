import type { Metadata } from "next";
import Link from "next/link";

import { ProbabilityDensityChart } from "@/components/charts/ProbabilityDensityChart";
import { SmileChart, Swatch, type SmilePoint } from "@/components/charts/SmileChart";
import { Segmented, withParams } from "@/components/Segmented";
import { Card, CardHeader, EmptyState, PIPELINE_COMMAND } from "@/components/ui";
import { expiryKey, loadDensity, loadIv, loadMeta, loadSvi, type SviRow } from "@/lib/data";
import { daysToExpiry, fmtExpiry, fmtInt, fmtPct, fmtPrice, fmtVolPts } from "@/lib/format";

/** Linearly interpolate the (sorted) CDF at an arbitrary price. */
function cdfAt(points: { strike: number; cdf: number }[], price: number): number {
  if (points.length === 0) return NaN;
  if (price <= points[0].strike) return points[0].cdf;
  if (price >= points[points.length - 1].strike) return points[points.length - 1].cdf;
  let i = 1;
  while (points[i].strike < price) i++;
  const a = points[i - 1];
  const b = points[i];
  const t = (price - a.strike) / (b.strike - a.strike);
  return a.cdf + t * (b.cdf - a.cdf);
}

export const metadata: Metadata = { title: "Vol surface" };

const NEAR_BAND = 0.06; // ±6% of the forward

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** ATM implied vol from the fit: k = 0 at the forward. */
const atmVol = (s: SviRow) =>
  Math.sqrt(Math.max(s.a + s.b * (s.rho * -s.m + Math.sqrt(s.m ** 2 + s.sigma ** 2)), 0) / s.time_to_expiry);

const PARAMS: { key: keyof SviRow; name: string; meaning: string; digits: number }[] = [
  { key: "a", name: "a", meaning: "overall variance level", digits: 5 },
  { key: "b", name: "b", meaning: "wing steepness", digits: 4 },
  { key: "rho", name: "ρ", meaning: "skew: negative = puts richer", digits: 3 },
  { key: "m", name: "m", meaning: "horizontal shift of the vertex", digits: 4 },
  { key: "sigma", name: "σ", meaning: "curvature at the vertex", digits: 4 },
];

export default async function SurfacePage({ searchParams }: { searchParams: SearchParams }) {
  const [sp, meta, iv, svi, density] = await Promise.all([searchParams, loadMeta(), loadIv(), loadSvi(), loadDensity()]);
  if (!meta || !iv || !svi || svi.length === 0) {
    return <EmptyState title="No fitted surface yet." command={PIPELINE_COMMAND} />;
  }

  const fits = [...svi].sort((a, b) => a.expiry.localeCompare(b.expiry));
  const fitKeys = fits.map((f) => expiryKey(f.expiry));
  const expiry = fitKeys.includes(one(sp.expiry) ?? "") ? one(sp.expiry)! : fitKeys[0];
  const range = one(sp.range) === "all" ? "all" : "near";
  const current = { expiry, range };
  const fit = fits[fitKeys.indexOf(expiry)];

  const points: SmilePoint[] = iv
    .filter((r) => expiryKey(r.expiry) === expiry && r.iv_mid != null)
    .filter((r) => range === "all" || Math.abs(r.strike / fit.forward - 1) <= NEAR_BAND)
    .sort((a, b) => a.strike - b.strike)
    .map((r) => ({ strike: r.strike, ivBid: r.iv_bid, ivMid: r.iv_mid!, ivAsk: r.iv_ask }));

  const dte = daysToExpiry(expiry, meta.fetchedAt);
  // Where the data actually is, in log-moneyness: a vertex (m) outside it means only one
  // arm of the hyperbola is fitted, so rho and m aren't individually identifiable.
  const ks = iv.filter((r) => expiryKey(r.expiry) === expiry && r.iv_mid != null).map((r) => Math.log(r.strike / fit.forward));
  const vertexOutside = fit.m < Math.min(...ks) || fit.m > Math.max(...ks);

  const spot = meta.underlying;
  const densityPoints = (density ?? [])
    .filter((r) => expiryKey(r.expiry) === expiry)
    .sort((a, b) => a.strike - b.strike);
  const levels: { label: string; price: number; below: boolean }[] = [
    { label: `Above spot (${fmtPrice(spot, 0)})`, price: spot, below: false },
    { label: `Above +5% (${fmtPrice(spot * 1.05, 0)})`, price: spot * 1.05, below: false },
    { label: `Above +10% (${fmtPrice(spot * 1.1, 0)})`, price: spot * 1.1, below: false },
    { label: `Below -5% (${fmtPrice(spot * 0.95, 0)})`, price: spot * 0.95, below: true },
    { label: `Below -10% (${fmtPrice(spot * 0.9, 0)})`, price: spot * 0.9, below: true },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Volatility surface</h1>
        <p className="mt-1 max-w-2xl text-[14px] leading-6 text-ink-2">
          Implied vol inverted separately from each strike&apos;s bid, mid, and ask (out-of-the-money leg, forward from
          put-call parity), with a 5-parameter raw SVI curve fitted to the mids.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Expiry"
          value={expiry}
          hrefFor={(v) => withParams("/surface", current, { expiry: v })}
          options={fitKeys.map((k) => ({ value: k, label: fmtExpiry(k), hint: `${daysToExpiry(k, meta.fetchedAt)}d` }))}
        />
        <Segmented
          label="Strike range"
          value={range}
          hrefFor={(v) => withParams("/surface", current, { range: v })}
          options={[
            { value: "near", label: "Near the forward", hint: "±6%" },
            { value: "all", label: "All strikes" },
          ]}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader
            title={`Smile · ${fmtExpiry(expiry)} · ${dte} DTE`}
            description="Each vertical line is one strike's bid-to-ask IV range: what trading the smile costs. Dots are mid IVs; the line is the SVI fit."
          />
          <ul className="flex flex-wrap gap-x-5 gap-y-1 px-5 pt-3 text-[12px] text-ink-2 sm:px-6">
            <li className="flex items-center gap-1.5"><Swatch kind="dot" color="var(--series-1)" />Mid IV</li>
            <li className="flex items-center gap-1.5"><Swatch kind="range" color="var(--series-1)" />Bid – ask IV range</li>
            <li className="flex items-center gap-1.5"><Swatch kind="line" color="var(--series-2)" />SVI fit</li>
          </ul>
          <div className="px-2 pt-2 pb-4 sm:px-4">
            {points.length > 1 ? (
              <SmileChart
                points={points}
                svi={{ a: fit.a, b: fit.b, rho: fit.rho, m: fit.m, sigma: fit.sigma }}
                forward={fit.forward}
                timeToExpiry={fit.time_to_expiry}
                label={`${meta.symbol} implied volatility smile for ${fmtExpiry(expiry)}, ${points.length} strikes`}
              />
            ) : (
              <p className="py-16 text-center text-sm text-ink-2">Not enough strikes in this range.</p>
            )}
          </div>
        </Card>

        <Card className="min-w-0">
          <CardHeader title="SVI fit" description="w(k) = a + b(ρ(k − m) + √((k − m)² + σ²)), with k = ln(K/F) and w = IV² · T." />
          <dl className="grid grid-cols-2 gap-3 px-5 pt-4 sm:px-6">
            <div>
              <dt className="text-[12px] text-ink-2">ATM vol</dt>
              <dd className="text-xl font-semibold tracking-tight">{fmtPct(atmVol(fit))}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-ink-2">Fit error (RMSE)</dt>
              <dd className="text-xl font-semibold tracking-tight">{fmtVolPts(fit.rmse_iv)}</dd>
            </div>
          </dl>
          <table className="mt-4 w-full text-[13px] tabular-nums">
            <caption className="sr-only">Fitted SVI parameters</caption>
            <tbody>
              {PARAMS.map((pm) => (
                <tr key={pm.key} className="border-t border-line">
                  <th scope="row" className="w-10 py-2 pl-5 text-left font-medium text-ink sm:pl-6">{pm.name}</th>
                  <td className="py-2 text-ink-2">{pm.meaning}</td>
                  <td className="py-2 pr-5 text-right text-ink sm:pr-6">{(fit[pm.key] as number).toFixed(pm.digits)}</td>
                </tr>
              ))}
              <tr className="border-t border-line">
                <th scope="row" className="py-2 pl-5 text-left font-medium text-ink sm:pl-6">F</th>
                <td className="py-2 text-ink-2">forward, from put-call parity</td>
                <td className="py-2 pr-5 text-right text-ink sm:pr-6">{fmtPrice(fit.forward)}</td>
              </tr>
              <tr className="border-t border-line">
                <th scope="row" className="py-2 pl-5 text-left font-medium text-ink sm:pl-6">n</th>
                <td className="py-2 text-ink-2">strikes in the fit</td>
                <td className="py-2 pr-5 text-right text-ink sm:pr-6">{fmtInt(fit.n_points)}</td>
              </tr>
            </tbody>
          </table>
          {vertexOutside && (
            <p className="mx-5 mt-3 mb-5 rounded-lg bg-surface-2 px-3 py-2 text-[12px] leading-4 text-ink-2 sm:mx-6">
              The fitted vertex (m) lies outside the observed strikes, so only one arm of the curve is pinned by data. The
              curve is reliable where there are quotes; ρ and m on their own are not.
            </p>
          )}
        </Card>
      </div>

      {densityPoints.length > 1 && (
        <Card>
          <CardHeader
            title={`Where the market thinks SPY lands · ${fmtExpiry(expiry)}`}
            description="The fitted smile's own risk-neutral probability of finishing at each price by expiry (Breeden-Litzenberger: the smile's curvature, strike by strike, is the market's implied density)."
          />
          <div className="grid gap-4 px-2 pt-2 pb-4 sm:px-4 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              <ProbabilityDensityChart
                points={densityPoints}
                spot={spot}
                label={`Risk-neutral probability density of ${meta.symbol} at expiry ${fmtExpiry(expiry)}`}
              />
            </div>
            <div className="px-3 lg:px-0">
              <table className="w-full text-[13px] tabular-nums">
                <caption className="sr-only">Probability of {meta.symbol} finishing above or below key levels</caption>
                <tbody>
                  {levels.map((lv) => {
                    const cdf = cdfAt(densityPoints, lv.price);
                    const p = lv.below ? cdf : 1 - cdf;
                    return (
                      <tr key={lv.label} className="border-b border-line last:border-0">
                        <td className="py-2 pr-3 text-ink-2">{lv.label}</td>
                        <td className="py-2 text-right font-medium text-ink">{fmtPct(p)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="All expiries" description="One SVI fit per expiry. Select a row to plot it." />
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13px] tabular-nums">
            <caption className="sr-only">SVI fits for every expiry</caption>
            <thead>
              <tr className="border-y border-line text-left text-[12px] text-muted">
                {["Expiry", "DTE", "Forward", "ATM vol", "a", "b", "ρ", "m", "σ", "RMSE", "n"].map((h, i) => (
                  <th key={h} scope="col" className={`py-2 font-normal ${i === 0 ? "pl-5 sm:pl-6" : "text-right"} ${i === 10 ? "pr-5 sm:pr-6" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fits.map((f) => {
                const k = expiryKey(f.expiry);
                const sel = k === expiry;
                return (
                  <tr key={k} className={`border-b border-line last:border-0 ${sel ? "bg-surface-2" : "hover:bg-surface-2/60"}`}>
                    <th scope="row" className="py-2 pl-5 text-left font-normal sm:pl-6">
                      <Link
                        href={withParams("/surface", current, { expiry: k })}
                        aria-current={sel ? "true" : undefined}
                        className={sel ? "font-medium text-ink" : "text-ink-2 hover:text-ink"}
                      >
                        {fmtExpiry(k)}
                      </Link>
                    </th>
                    <td className="py-2 text-right text-ink-2">{daysToExpiry(k, meta.fetchedAt)}</td>
                    <td className="py-2 text-right">{fmtPrice(f.forward)}</td>
                    <td className="py-2 text-right font-medium">{fmtPct(atmVol(f))}</td>
                    <td className="py-2 text-right text-ink-2">{f.a.toFixed(4)}</td>
                    <td className="py-2 text-right text-ink-2">{f.b.toFixed(4)}</td>
                    <td className="py-2 text-right text-ink-2">{f.rho.toFixed(3)}</td>
                    <td className="py-2 text-right text-ink-2">{f.m.toFixed(4)}</td>
                    <td className="py-2 text-right text-ink-2">{f.sigma.toFixed(4)}</td>
                    <td className="py-2 text-right">{fmtVolPts(f.rmse_iv)}</td>
                    <td className="py-2 pr-5 text-right text-ink-2 sm:pr-6">{f.n_points}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
