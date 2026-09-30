"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";

import { fmtPct, fmtPrice } from "@/lib/format";
import { linear, niceTicks } from "@/lib/scale";
import { useWidth } from "./useWidth";

export type DensityPoint = { strike: number; density: number; cdf: number };

const M = { top: 16, right: 16, bottom: 36, left: 16 };
const HEIGHT = 260;

export function ProbabilityDensityChart({ points, spot, label }: { points: DensityPoint[]; spot: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const kMin = points[0]?.strike ?? spot;
  const kMax = points[points.length - 1]?.strike ?? spot;
  const dMax = Math.max(...points.map((p) => p.density));
  const y = linear([0, dMax], [HEIGHT - M.bottom, M.top]);
  const x = linear([kMin, kMax], [M.left, width - M.right]);
  const xTicks = niceTicks(kMin, kMax, Math.max(2, Math.floor((width - M.left - M.right) / 80))).filter(
    (t) => t >= kMin && t <= kMax,
  );

  const areaPath =
    points.length > 0
      ? `M${x(points[0].strike).toFixed(1)},${y(0).toFixed(1)} ` +
        points.map((p) => `L${x(p.strike).toFixed(1)},${y(p.density).toFixed(1)}`).join(" ") +
        ` L${x(points[points.length - 1].strike).toFixed(1)},${y(0).toFixed(1)} Z`
      : "";
  const linePath = points.map((p, i) => `${i ? "L" : "M"}${x(p.strike).toFixed(1)},${y(p.density).toFixed(1)}`).join("");

  const nearest = (px: number) => {
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(x(points[i].strike) - px) < Math.abs(x(points[best].strike) - px)) best = i;
    }
    return best;
  };
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    setActive(nearest(e.clientX - rect.left));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 1 : -1;
    setActive((i) => Math.min(points.length - 1, Math.max(0, (i ?? nearest(x(spot))) + step)));
  };

  const p = active === null ? null : points[active];
  const px = p ? x(p.strike) : 0;

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`${label}. Use left and right arrow keys to step through prices.`}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setActive((i) => i ?? nearest(x(spot)))}
        onBlur={() => setActive(null)}
        className="block overflow-visible"
      >
        <line x1={M.left} x2={width - M.right} y1={HEIGHT - M.bottom} y2={HEIGHT - M.bottom} stroke="var(--axis)" />
        {xTicks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={M.top} y2={HEIGHT - M.bottom} stroke="var(--grid)" />
            <text x={x(t)} y={HEIGHT - M.bottom + 16} textAnchor="middle" className="fill-muted text-[11px] tabular-nums">
              {fmtPrice(t, 0)}
            </text>
          </g>
        ))}
        <text x={width - M.right} y={HEIGHT - 4} textAnchor="end" className="fill-muted text-[11px]">SPY price at expiry</text>

        <path d={areaPath} fill="var(--series-1)" fillOpacity={0.12} stroke="none" />
        <path d={linePath} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {spot >= kMin && spot <= kMax && (
          <g>
            <line x1={x(spot)} x2={x(spot)} y1={M.top} y2={HEIGHT - M.bottom} stroke="var(--axis)" strokeDasharray="3 3" />
            <text x={x(spot) + 4} y={M.top + 10} className="fill-muted text-[11px] tabular-nums">Spot {fmtPrice(spot)}</text>
          </g>
        )}

        {p && (
          <g pointerEvents="none">
            <line x1={px} x2={px} y1={M.top} y2={HEIGHT - M.bottom} stroke="var(--ink-2)" strokeWidth={1} />
            <circle cx={px} cy={y(p.density)} r={5.5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}

        <rect
          x={M.left}
          y={M.top}
          width={Math.max(0, width - M.left - M.right)}
          height={HEIGHT - M.top - M.bottom}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
        />
      </svg>

      {p && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 w-44 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm"
          style={{ top: M.top, left: px > width / 2 ? px - 176 : px + 12 }}
        >
          <div className="mb-1 font-medium text-ink-2">{fmtPrice(p.strike, 0)}</div>
          <div className="flex justify-between gap-3">
            <span className="text-ink-2">P(above)</span>
            <span className="tabular-nums text-ink">{fmtPct(1 - p.cdf)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-ink-2">P(below)</span>
            <span className="tabular-nums text-ink">{fmtPct(p.cdf)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
