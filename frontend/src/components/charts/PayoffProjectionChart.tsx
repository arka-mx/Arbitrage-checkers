"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";

import { TableView } from "@/components/ui";
import { fmtPrice } from "@/lib/format";
import type { PayoffPoint } from "@/lib/payoff";
import { linear, niceTicks } from "@/lib/scale";
import { useWidth } from "./useWidth";

const M = { top: 16, right: 16, bottom: 32, left: 64 };
const HEIGHT = 220;

export function PayoffProjectionChart({ series, label }: { series: PayoffPoint[]; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const dayMin = series[0]?.day ?? 0;
  const dayMax = series[series.length - 1]?.day ?? 0;
  const pnls = series.map((s) => s.pnl);
  const yTicks = niceTicks(Math.min(0, ...pnls), Math.max(0, ...pnls), 5);
  const y = linear([yTicks[0], yTicks[yTicks.length - 1]], [HEIGHT - M.bottom, M.top]);
  const x = linear([dayMin, dayMax], [M.left, width - M.right]);
  const xTicks = niceTicks(dayMin, dayMax, Math.max(2, Math.floor((width - M.left - M.right) / 70))).filter(
    (t) => t >= dayMin && t <= dayMax,
  );

  const path = series.map((s, i) => `${i ? "L" : "M"}${x(s.day).toFixed(1)},${y(s.pnl).toFixed(1)}`).join("");

  const nearest = (px: number) => {
    let best = 0;
    for (let i = 1; i < series.length; i++) {
      if (Math.abs(x(series[i].day) - px) < Math.abs(x(series[best].day) - px)) best = i;
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
    setActive((i) => Math.min(series.length - 1, Math.max(0, (i ?? 0) + step)));
  };

  const p = active === null ? null : series[active];
  const px = p ? x(p.day) : 0;

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`${label}. Use left and right arrow keys to step through days.`}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setActive((i) => i ?? 0)}
        onBlur={() => setActive(null)}
        className="block overflow-visible"
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
              {fmtPrice(t, 0)}
            </text>
          </g>
        ))}
        {yTicks[0] < 0 && yTicks[yTicks.length - 1] > 0 && (
          <line x1={M.left} x2={width - M.right} y1={y(0)} y2={y(0)} stroke="var(--axis)" />
        )}
        <line x1={M.left} x2={width - M.right} y1={HEIGHT - M.bottom} y2={HEIGHT - M.bottom} stroke="var(--axis)" />
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={HEIGHT - M.bottom + 16} textAnchor="middle" className="fill-muted text-[11px] tabular-nums">
            {t}
          </text>
        ))}
        <text x={width - M.right} y={HEIGHT - 4} textAnchor="end" className="fill-muted text-[11px]">Days from now</text>

        <path d={path} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {series[0] && (
          <circle cx={x(series[0].day)} cy={y(series[0].pnl)} r={4} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
        )}

        {p && (
          <g pointerEvents="none">
            <line x1={px} x2={px} y1={M.top} y2={HEIGHT - M.bottom} stroke="var(--ink-2)" strokeWidth={1} />
            <circle cx={px} cy={y(p.pnl)} r={5.5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
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
          className="pointer-events-none absolute z-10 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm"
          style={{ top: M.top, left: px > width / 2 ? px - 140 : px + 12 }}
        >
          <div className="mb-1 font-medium text-ink-2">{p.day === 0 ? "Close today" : `Close in ${p.day}d`}</div>
          <div className="tabular-nums text-ink">{fmtPrice(p.pnl)}</div>
        </div>
      )}

      <TableView
        caption="Projected P&L by days from now"
        head={["Day", "Projected P&L"]}
        rows={series
          .filter((_, i) => i % Math.max(1, Math.ceil(series.length / 30)) === 0 || i === series.length - 1)
          .map((s) => [s.day === 0 ? "Today" : `+${s.day}d`, fmtPrice(s.pnl)])}
      />
    </div>
  );
}
