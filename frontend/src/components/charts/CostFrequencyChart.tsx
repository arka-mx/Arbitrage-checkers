"use client";

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";

import { fmtInt, fmtPrice } from "@/lib/format";
import { linear, logScale, logTicks, niceTicks } from "@/lib/scale";
import { Swatch } from "./SmileChart";
import { useWidth } from "./useWidth";

export type CostPoint = {
  label: string;
  kind: "interval" | "band";
  meanTrades: number;
  transactionCost: number;
  replicationError: number;
  totalCost: number;
};

const M = { top: 16, right: 16, bottom: 36, left: 52 };
const HEIGHT = 340;
const SERIES = {
  interval: { color: "var(--series-1)", name: "Fixed interval" },
  band: { color: "var(--series-2)", name: "Band-triggered" },
} as const;

export function CostFrequencyChart({ points, label }: { points: CostPoint[]; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const sorted = useMemo(() => [...points].sort((a, b) => a.meanTrades - b.meanTrades), [points]);
  const bestIdx = sorted.reduce((b, p, i) => (p.totalCost < sorted[b].totalCost ? i : b), 0);

  const tradeDomain: [number, number] = [
    Math.min(...points.map((p) => p.meanTrades)),
    Math.max(...points.map((p) => p.meanTrades)),
  ];
  const x = logScale(tradeDomain, [M.left, width - M.right]);
  const xTicks = logTicks(...tradeDomain);

  const costs = points.map((p) => p.totalCost);
  const yTicks = niceTicks(0, Math.max(...costs), 5);
  const y = linear([0, yTicks[yTicks.length - 1]], [HEIGHT - M.bottom, M.top]);

  const lineFor = (kind: "interval" | "band") => {
    const pts = sorted.filter((p) => p.kind === kind);
    return pts.length > 1 ? pts.map((p, i) => `${i ? "L" : "M"}${x(p.meanTrades).toFixed(1)},${y(p.totalCost).toFixed(1)}`).join("") : null;
  };

  const nearest = (px: number) => {
    let best = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(x(sorted[i].meanTrades) - px) < Math.abs(x(sorted[best].meanTrades) - px)) best = i;
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
    setActive((i) => Math.min(sorted.length - 1, Math.max(0, (i ?? 0) + step)));
  };

  const p = active === null ? null : sorted[active];
  const px = p ? x(p.meanTrades) : 0;

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`${label}. Use left and right arrow keys to step through points.`}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setActive((i) => i ?? bestIdx)}
        onBlur={() => setActive(null)}
        className="block overflow-visible"
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
              {fmtInt(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={HEIGHT - M.bottom + 16} textAnchor="middle" className="fill-muted text-[11px] tabular-nums">
            {fmtInt(t)}
          </text>
        ))}
        <line x1={M.left} x2={width - M.right} y1={HEIGHT - M.bottom} y2={HEIGHT - M.bottom} stroke="var(--axis)" />
        <text x={width - M.right} y={HEIGHT - 4} textAnchor="end" className="fill-muted text-[11px]">Rebalances over the option&apos;s life (log scale)</text>
        <text x={M.left} y={M.top - 4} className="fill-muted text-[11px]">$ total cost</text>

        {(["interval", "band"] as const).map((kind) => {
          const d = lineFor(kind);
          return d && <path key={kind} d={d} fill="none" stroke={SERIES[kind].color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />;
        })}

        {sorted.map((pt, i) => (
          <circle
            key={pt.label}
            cx={x(pt.meanTrades)}
            cy={y(pt.totalCost)}
            r={i === bestIdx ? 6 : 4}
            fill={SERIES[pt.kind].color}
            stroke="var(--surface)"
            strokeWidth={2}
            opacity={p && p.label !== pt.label ? 0.6 : 1}
          />
        ))}

        {p && (
          <line x1={px} x2={px} y1={M.top} y2={HEIGHT - M.bottom} stroke="var(--ink-2)" strokeWidth={1} pointerEvents="none" />
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
          className="pointer-events-none absolute z-10 w-52 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm"
          style={{ top: M.top, left: px > width / 2 ? px - 216 : px + 12 }}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-medium text-ink">{p.label}</span>
            {sorted.indexOf(p) === bestIdx && (
              <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-2">Lowest cost</span>
            )}
          </div>
          <Row swatch="dot" color={SERIES[p.kind].color} name={SERIES[p.kind].name} value={`${fmtInt(p.meanTrades)} trades`} />
          <Row swatch="dot" color="transparent" name="Slippage" value={fmtPrice(p.transactionCost)} />
          <Row swatch="dot" color="transparent" name="Hedge noise" value={fmtPrice(p.replicationError)} />
          <div className="mt-1 flex justify-between border-t border-line pt-1 font-medium text-ink">
            <span>Total cost</span>
            <span className="tabular-nums">{fmtPrice(p.totalCost)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ swatch, color, name, value }: { swatch: "dot"; color: string; name: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      {color !== "transparent" ? <Swatch kind={swatch} color={color} /> : <span className="w-3.5" />}
      <span className="text-ink-2">{name}</span>
      <span className="ml-auto tabular-nums text-ink">{value}</span>
    </div>
  );
}

export const COST_SERIES = SERIES;
