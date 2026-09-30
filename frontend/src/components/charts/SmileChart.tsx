"use client";

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";

import { fmtPct, fmtPrice, fmtVolPts } from "@/lib/format";
import { linear, niceTicks } from "@/lib/scale";
import { sviImpliedVol, type SviParams } from "@/lib/svi";
import { useWidth } from "./useWidth";

export type SmilePoint = { strike: number; ivBid: number | null; ivMid: number; ivAsk: number | null };
export type { SviParams };

const M = { top: 16, right: 16, bottom: 36, left: 44 };
const HEIGHT = 340;

const sviVol = sviImpliedVol;

export function SmileChart({
  points,
  svi,
  forward,
  timeToExpiry,
  label,
}: {
  points: SmilePoint[];
  svi: SviParams | null;
  forward: number;
  timeToExpiry: number;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const kMin = points[0]?.strike ?? forward;
  const kMax = points[points.length - 1]?.strike ?? forward;
  const curve = useMemo(() => {
    if (!svi) return [];
    const n = 160;
    return Array.from({ length: n + 1 }, (_, i) => {
      const k = kMin + ((kMax - kMin) * i) / n;
      return { strike: k, vol: sviVol(svi, k, forward, timeToExpiry) };
    });
  }, [svi, kMin, kMax, forward, timeToExpiry]);

  const vols = [
    ...points.flatMap((p) => [p.ivBid ?? p.ivMid, p.ivAsk ?? p.ivMid]),
    ...curve.map((c) => c.vol),
  ].filter(Number.isFinite);
  const yTicks = niceTicks(Math.min(...vols), Math.max(...vols), 5);
  const y = linear([yTicks[0], yTicks[yTicks.length - 1]], [HEIGHT - M.bottom, M.top]);
  const x = linear([kMin, kMax], [M.left, width - M.right]);
  const xTicks = niceTicks(kMin, kMax, Math.max(2, Math.floor((width - M.left - M.right) / 90))).filter(
    (t) => t >= kMin && t <= kMax,
  );

  const curvePath = curve.map((c, i) => `${i ? "L" : "M"}${x(c.strike).toFixed(1)},${y(c.vol).toFixed(1)}`).join("");

  // Dense strike grids ($1 apart over a wide range): full-size ringed dots merge into a
  // hollow smear that hides the fit. Go smaller, drop the ring, and draw the fit on top.
  const minGap = points.reduce(
    (g, pt, i) => (i ? Math.min(g, x(pt.strike) - x(points[i - 1].strike)) : g),
    Number.POSITIVE_INFINITY,
  );
  const dense = minGap < 10;
  const dotR = dense ? 2.5 : 4;
  const fitPath = curve.length > 0 && (
    <path d={curvePath} fill="none" stroke="var(--series-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
  );

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
    setActive((i) => Math.min(points.length - 1, Math.max(0, (i ?? nearest(x(forward))) + step)));
  };

  const p = active === null ? null : points[active];
  const pSvi = p && svi ? sviVol(svi, p.strike, forward, timeToExpiry) : null;
  const px = p ? x(p.strike) : 0;

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`${label}. Use left and right arrow keys to step through strikes.`}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setActive((i) => i ?? nearest(x(forward)))}
        onBlur={() => setActive(null)}
        className="block overflow-visible"
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        <line x1={M.left} x2={width - M.right} y1={HEIGHT - M.bottom} y2={HEIGHT - M.bottom} stroke="var(--axis)" />
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={HEIGHT - M.bottom + 16} textAnchor="middle" className="fill-muted text-[11px] tabular-nums">
            {t}
          </text>
        ))}
        <text x={width - M.right} y={HEIGHT - 4} textAnchor="end" className="fill-muted text-[11px]">Strike</text>

        {forward >= kMin && forward <= kMax && (
          <g>
            <line x1={x(forward)} x2={x(forward)} y1={M.top} y2={HEIGHT - M.bottom} stroke="var(--axis)" />
            <text x={x(forward) + 4} y={M.top + 10} className="fill-muted text-[11px] tabular-nums">
              F {fmtPrice(forward)}
            </text>
          </g>
        )}

        {/* Bid-ask IV range per strike: the cost of trading the smile. */}
        {points.map(
          (pt) =>
            pt.ivBid != null &&
            pt.ivAsk != null && (
              <line
                key={`r${pt.strike}`}
                x1={x(pt.strike)}
                x2={x(pt.strike)}
                y1={y(pt.ivBid)}
                y2={y(pt.ivAsk)}
                stroke="var(--series-1)"
                strokeOpacity={0.35}
                strokeWidth={2}
                strokeLinecap="round"
              />
            ),
        )}

        {!dense && fitPath}

        {points.map((pt) => (
          <circle
            key={`m${pt.strike}`}
            cx={x(pt.strike)}
            cy={y(pt.ivMid)}
            r={dotR}
            fill="var(--series-1)"
            stroke={dense ? "none" : "var(--surface)"}
            strokeWidth={2}
            opacity={p && p.strike !== pt.strike ? 0.6 : 1}
          />
        ))}

        {dense && fitPath}

        {p && (
          <g pointerEvents="none">
            <line x1={px} x2={px} y1={M.top} y2={HEIGHT - M.bottom} stroke="var(--ink-2)" strokeWidth={1} />
            <circle cx={px} cy={y(p.ivMid)} r={5.5} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={2} />
            {pSvi != null && <circle cx={px} cy={y(pSvi)} r={4} fill="var(--series-2)" stroke="var(--surface)" strokeWidth={2} />}
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
          className="pointer-events-none absolute z-10 w-48 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm"
          style={{ top: M.top, left: px > width / 2 ? px - 204 : px + 12 }}
        >
          <div className="mb-1 font-medium text-ink-2">Strike {fmtPrice(p.strike, p.strike % 1 ? 1 : 0)}</div>
          <Row swatch="dot" color="var(--series-1)" name="Mid IV" value={fmtPct(p.ivMid, 2)} strong />
          <Row swatch="range" color="var(--series-1)" name="Bid – ask" value={`${fmtPct(p.ivBid, 1)} – ${fmtPct(p.ivAsk, 1)}`} />
          {pSvi != null && <Row swatch="line" color="var(--series-2)" name="SVI fit" value={fmtPct(pSvi, 2)} />}
          {pSvi != null && (
            <div className="mt-1 border-t border-line pt-1 text-muted">
              Mid − SVI <span className="float-right tabular-nums text-ink-2">{fmtVolPts(p.ivMid - pSvi)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ swatch, color, name, value, strong }: { swatch: "dot" | "line" | "range"; color: string; name: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <Swatch kind={swatch} color={color} />
      <span className="text-ink-2">{name}</span>
      <span className={`ml-auto tabular-nums ${strong ? "font-semibold text-ink" : "text-ink"}`}>{value}</span>
    </div>
  );
}

export function Swatch({ kind, color }: { kind: "dot" | "line" | "range"; color: string }) {
  return (
    <svg width={14} height={10} aria-hidden className="shrink-0">
      {kind === "dot" && <circle cx={7} cy={5} r={4} fill={color} />}
      {kind === "line" && <line x1={1} x2={13} y1={5} y2={5} stroke={color} strokeWidth={2} strokeLinecap="round" />}
      {kind === "range" && <line x1={7} x2={7} y1={1} y2={9} stroke={color} strokeOpacity={0.35} strokeWidth={2} strokeLinecap="round" />}
    </svg>
  );
}
