"use client";

import { useState } from "react";

import { fmtInt } from "@/lib/format";
import { linear, niceTicks } from "@/lib/scale";
import { useWidth } from "./useWidth";

export type StackSeries = { key: string; label: string; color: string };
export type StackRow = { key: string; label: string; values: Record<string, number>; endLabel: string };

const ROW_H = 40;
const BAR = 20; // <= 24px
const GAP = 2; // surface gap between segments
const R = 4;
const M = { top: 4, right: 96, bottom: 24, left: 120 };

/** Rounded right (data) end only when this is the last segment; left edge stays square. */
function segPath(x: number, y: number, w: number, h: number, roundEnd: boolean) {
  if (!roundEnd) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
  const r = Math.min(R, w, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

export function StackedBarChart({ rows, series, label }: { rows: StackRow[]; series: StackSeries[]; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<{ row: number; seg: number } | null>(null);

  const narrow = width < 480;
  const m = { ...M, left: narrow ? 92 : M.left, right: narrow ? 72 : M.right };
  const height = M.top + rows.length * ROW_H + M.bottom;
  const totals = rows.map((r) => series.reduce((s, se) => s + (r.values[se.key] ?? 0), 0));
  const ticks = niceTicks(0, Math.max(...totals, 1), narrow ? 3 : 5);
  const x = linear([0, ticks[ticks.length - 1]], [m.left, width - m.right]);

  const tip = active && { row: rows[active.row], se: series[active.seg], total: totals[active.row] };

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={M.top} y2={height - M.bottom} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} />
            <text x={x(t)} y={height - M.bottom + 16} textAnchor="middle" className="fill-muted text-[11px] tabular-nums">
              {fmtInt(t)}
            </text>
          </g>
        ))}

        {rows.map((row, ri) => {
          const y = M.top + ri * ROW_H + (ROW_H - BAR) / 2;
          const present = series.map((se, si) => ({ se, si, v: row.values[se.key] ?? 0 })).filter((s) => s.v > 0);
          let cursor = 0;
          return (
            <g key={row.key}>
              <text x={m.left - 10} y={y + BAR / 2} dy="0.32em" textAnchor="end" className="fill-ink-2 text-[12px]">
                {row.label}
              </text>
              {present.map(({ se, si, v }, pi) => {
                const x0 = x(cursor) + (pi > 0 ? GAP / 2 : 0);
                cursor += v;
                const x1 = x(cursor) - (pi < present.length - 1 ? GAP / 2 : 0);
                const on = active?.row === ri && active.seg === si;
                return (
                  <g
                    key={se.key}
                    tabIndex={0}
                    role="img"
                    aria-label={`${row.label}, ${se.label}: ${fmtInt(v)} of ${fmtInt(totals[ri])}`}
                    onPointerEnter={() => setActive({ row: ri, seg: si })}
                    onPointerLeave={() => setActive(null)}
                    onFocus={() => setActive({ row: ri, seg: si })}
                    onBlur={() => setActive(null)}
                    className="outline-none"
                  >
                    {/* Hit target: full row height across the segment. */}
                    <rect x={x0} y={M.top + ri * ROW_H} width={Math.max(x1 - x0, 1)} height={ROW_H} fill="transparent" />
                    <path
                      d={segPath(x0, y, Math.max(x1 - x0, 1), BAR, pi === present.length - 1)}
                      fill={se.color}
                      opacity={active && !on ? 0.55 : 1}
                    />
                  </g>
                );
              })}
              <text x={x(totals[ri]) + 8} y={y + BAR / 2} dy="0.32em" className="fill-ink-2 text-[12px] tabular-nums">
                {row.endLabel}
              </text>
            </g>
          );
        })}
      </svg>

      {tip && active && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-sm"
          // Above the bar, except the first row, where above would cover the legend.
          style={{ top: active.row === 0 ? M.top + ROW_H - 2 : M.top + active.row * ROW_H - 44, left: Math.min(Math.max(m.left, x(tip.total / 2) - 80), width - 180) }}
        >
          <div className="font-semibold text-ink tabular-nums">
            {fmtInt(tip.row.values[tip.se.key])}{" "}
            <span className="font-normal text-ink-2">of {fmtInt(tip.total)}</span>
          </div>
          <div className="flex items-center gap-1.5 whitespace-nowrap text-ink-2">
            <svg width={10} height={10} aria-hidden>
              <rect width={10} height={10} rx={2} fill={tip.se.color} />
            </svg>
            {tip.se.label} · {tip.row.label}
          </div>
        </div>
      )}
    </div>
  );
}
