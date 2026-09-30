"use client";

import { useState } from "react";

import { UNITS, type Unit } from "@/lib/format";
import { linear, niceTicks } from "@/lib/scale";
import { useWidth } from "./useWidth";

export type Column = { key: string; label: string; detail?: string; value: number };

const M = { top: 20, right: 8, bottom: 28, left: 48 };
const MAX_BAR = 24;
const RADIUS = 4;

/** Rounded data-end, square at the baseline. */
function barPath(x: number, y: number, w: number, h: number) {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function ColumnChart({
  data,
  unit,
  height = 240,
  label,
}: {
  data: Column[];
  unit: Unit;
  height?: number;
  label: string;
}) {
  const format = UNITS[unit].value;
  const tickFormat = UNITS[unit].tick;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const ticks = niceTicks(0, Math.max(...data.map((d) => d.value), 0), 4);
  const y = linear([0, ticks[ticks.length - 1] ?? 1], [height - M.bottom, M.top]);
  const band = (width - M.left - M.right) / Math.max(data.length, 1);
  const barW = Math.min(MAX_BAR, band * 0.6);
  const maxIdx = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);
  // Thin out x labels when bands get narrow, always keeping the first and last.
  const labelEvery = Math.max(1, Math.ceil(36 / band));

  const tip = active === null ? null : data[active];
  const tipX = active === null ? 0 : M.left + band * (active + 0.5);

  return (
    <div ref={ref} className="relative w-full">
      <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
              {tickFormat(t)}
            </text>
          </g>
        ))}

        {data.map((d, i) => {
          const x0 = M.left + band * i;
          const bx = x0 + (band - barW) / 2;
          const by = y(d.value);
          const showLabel = i % labelEvery === 0 || i === data.length - 1;
          return (
            <g
              key={d.key}
              tabIndex={0}
              role="img"
              aria-label={`${d.label}: ${format(d.value)}`}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className="outline-none"
            >
              {/* Hit target is the whole band, not just the painted bar. */}
              <rect x={x0} y={M.top} width={band} height={height - M.top - M.bottom} fill="transparent" />
              {active === i && (
                <rect x={x0 + 2} y={M.top} width={band - 4} height={height - M.top - M.bottom} rx={4} fill="var(--surface-2)" />
              )}
              <path d={barPath(bx, by, barW, y(0) - by)} fill="var(--series-1)" opacity={active === null || active === i ? 1 : 0.55} />
              {i === maxIdx && (
                <text x={bx + barW / 2} y={by - 6} textAnchor="middle" className="fill-ink-2 text-[11px] font-medium tabular-nums">
                  {format(d.value)}
                </text>
              )}
              {showLabel && (
                <text x={x0 + band / 2} y={height - M.bottom + 16} textAnchor="middle" className="fill-muted text-[11px] tabular-nums">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-sm"
          style={{ left: Math.min(Math.max(tipX, 70), width - 70) }}
        >
          <div className="font-semibold text-ink tabular-nums">{format(tip.value)}</div>
          <div className="whitespace-nowrap text-ink-2">{tip.detail ?? tip.label}</div>
        </div>
      )}
    </div>
  );
}
