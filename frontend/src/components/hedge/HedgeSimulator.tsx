"use client";

import { useCallback, useEffect, useId, useState } from "react";

import { CostFrequencyChart, COST_SERIES, type CostPoint } from "@/components/charts/CostFrequencyChart";
import { Card, CardHeader, StatTile, TableView } from "@/components/ui";
import { fmtInt, fmtPrice } from "@/lib/format";
import type { OptionType } from "@/lib/data";
import type { Side } from "@/lib/positions";

type Rule = {
  label: string;
  every_n_steps: number | null;
  band: number | null;
  mean_trades: number;
  transaction_cost: number;
  replication_error: number;
  total_cost: number;
};
type ApiResult = { premium: number; rules: Rule[] };

function NumberField({
  label, hint, value, onChange, min, step, suffix,
}: {
  label: string; hint: string; value: number; onChange: (v: number) => void; min: number; step: number; suffix: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] text-ink-2">{label}</label>
      <div className="mt-1 flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 focus-within:border-series-1">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
          className="w-full bg-transparent text-sm tabular-nums text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="text-[12px] text-muted">{suffix}</span>
      </div>
      <p className="mt-1 text-[11px] text-muted">{hint}</p>
    </div>
  );
}

export function HedgeSimulator({
  symbol, strike, optionType, expiryLabel, side, spot, timeToExpiry, initialVol,
}: {
  symbol: string; strike: number; optionType: OptionType; expiryLabel: string; side: Side;
  spot: number; timeToExpiry: number; initialVol: number;
}) {
  const [volPct, setVolPct] = useState(Math.round(initialVol * 1000) / 10);
  const [halfSpread, setHalfSpread] = useState(0.05);
  const [optionCommission, setOptionCommission] = useState(0.65);
  const [stockCommission, setStockCommission] = useState(0);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; data?: ApiResult; error?: string }>({
    status: "loading",
  });

  // Fetches and reports the result; doesn't touch state synchronously (safe to
  // call directly from the mount effect, whose initial state is already "loading").
  const fetchResult = useCallback(
    (vol: number, spread: number, optComm: number, stockComm: number) => {
      const qs = new URLSearchParams({
        spot: String(spot), strike: String(strike), optionType, side,
        timeToExpiry: String(timeToExpiry), vol: String(vol / 100), halfSpread: String(spread),
        optionCommissionPerContract: String(optComm), stockCommissionPerShare: String(stockComm),
      });
      fetch(`/api/hedge?${qs}`)
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          setState({ status: "ready", data: body });
        })
        .catch((err: Error) => setState({ status: "error", error: err.message }));
    },
    [spot, strike, optionType, side, timeToExpiry],
  );

  // For the Run button: reset to loading immediately (a normal event handler,
  // so a synchronous setState here is fine), then fetch.
  const run = useCallback(
    (vol: number, spread: number, optComm: number, stockComm: number) => {
      setState({ status: "loading" });
      fetchResult(vol, spread, optComm, stockComm);
    },
    [fetchResult],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps -- run on mount only; edits use the Run button
  useEffect(() => fetchResult(volPct, halfSpread, optionCommission, stockCommission), []);

  const rules = state.data?.rules ?? [];
  const points: CostPoint[] = rules.map((r) => ({
    label: r.label,
    kind: r.every_n_steps !== null ? "interval" : "band",
    meanTrades: r.mean_trades,
    transactionCost: r.transaction_cost,
    replicationError: r.replication_error,
    totalCost: r.total_cost,
  }));
  const best = rules.length > 0 ? rules.reduce((b, r) => (r.total_cost < b.total_cost ? r : b)) : null;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Simulation inputs"
          description={`Runs a Monte Carlo GBM path (1,200 paths) for the underlying, then delta-hedges the ${side === "short" ? "sold" : "bought"} option under each rule below.`}
        />
        <div className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-4 sm:px-6">
          <NumberField label="Volatility" hint="Simulated and hedged at this vol" value={volPct} onChange={setVolPct} min={1} step={0.5} suffix="%" />
          <NumberField
            label="Half-spread"
            hint="Half the underlying's bid-ask, paid per share traded"
            value={halfSpread}
            onChange={setHalfSpread}
            min={0.001}
            step={0.005}
            suffix="$/sh"
          />
          <NumberField
            label="Option commission"
            hint="Broker fee to open the position, paid once"
            value={optionCommission}
            onChange={setOptionCommission}
            min={0}
            step={0.05}
            suffix="$/contract"
          />
          <NumberField
            label="Stock commission"
            hint="Broker fee per share, on every hedge trade"
            value={stockCommission}
            onChange={setStockCommission}
            min={0}
            step={0.005}
            suffix="$/sh"
          />
        </div>
        <div className="flex justify-end border-t border-line px-5 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => run(volPct, halfSpread, optionCommission, stockCommission)}
            disabled={state.status === "loading"}
            className="rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {state.status === "loading" ? "Running…" : "Run simulation"}
          </button>
        </div>
      </Card>

      {state.status === "error" && (
        <Card className="px-6 py-6 text-center">
          <p className="text-sm text-critical">Simulation failed: {state.error}</p>
        </Card>
      )}

      {state.status === "loading" && !state.data && (
        <Card className="px-6 py-16 text-center text-sm text-ink-2">Running the hedge simulation…</Card>
      )}

      {state.data && (
        <div className={`space-y-5 transition-opacity ${state.status === "loading" ? "opacity-50" : ""}`}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatTile
              label={side === "short" ? "Premium received" : "Premium paid"}
              value={fmtPrice(state.data.premium)}
              detail="Black-Scholes fair value at the vol above"
            />
            {best && (
              <>
                <StatTile label="Cheapest rule" value={best.label} detail={`${fmtInt(best.mean_trades)} trades over the option's life`} />
                <StatTile label="Lowest total cost" value={fmtPrice(best.total_cost)} detail="slippage + hedging noise, at the minimum" />
              </>
            )}
          </div>

          <Card>
            <CardHeader
              title="Total cost vs. how often you hedge"
              description="Total cost = expected slippage (rises with frequency) + std. dev. of the frictionless hedging P&L (falls with frequency). Their sum traces the U; the marked point is its minimum."
            />
            <ul className="flex flex-wrap gap-x-5 gap-y-1 px-5 pt-3 text-[12px] text-ink-2 sm:px-6">
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: COST_SERIES.interval.color }} />
                {COST_SERIES.interval.name}
              </li>
              <li className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: COST_SERIES.band.color }} />
                {COST_SERIES.band.name}
              </li>
            </ul>
            <div className="px-2 pt-2 pb-4 sm:px-4">
              <CostFrequencyChart
                points={points}
                label={`Total hedging cost vs. number of rebalances for the ${symbol} ${strike} ${optionType === "CE" ? "call" : "put"} expiring ${expiryLabel}`}
              />
            </div>
            <TableView
              caption="Hedging cost by rule"
              head={["Rule", "Trades", "Slippage", "Hedge noise", "Total cost"]}
              rows={[...rules]
                .sort((a, b) => a.total_cost - b.total_cost)
                .map((r) => [
                  r.label,
                  fmtInt(r.mean_trades),
                  fmtPrice(r.transaction_cost),
                  fmtPrice(r.replication_error),
                  <span key="tc" className={r === best ? "font-semibold text-ink" : undefined}>
                    {fmtPrice(r.total_cost)}
                  </span>,
                ])}
            />
          </Card>
        </div>
      )}
    </div>
  );
}
