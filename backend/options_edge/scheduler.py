"""Keep the frontend's data files fresh automatically, on two cadences.

    python -m options_edge.scheduler --symbol SPY --fetch-interval 300 --recompute-interval 120

Runs until you stop it (Ctrl+C). Two independent loops:

  - Every ``fetch_interval`` seconds (default 300 = 5 min): a real network
    round trip — re-fetches contracts, live quotes, and the underlying's
    spot price from Alpaca. This is the expensive step.
  - Every ``recompute_interval`` seconds (default 120 = 2 min, and it only
    matters between fetches — a fetch always triggers an immediate
    recompute of its own): reruns IV -> SVI -> arbitrage against the most
    recently *fetched* snapshot, but using the current wall-clock time as
    the valuation time.

That second loop is not a no-op just because the quotes haven't changed:
time to expiry keeps shrinking every tick, and IV/SVI/vol-cost are all
functions of time to expiry, so they visibly move between fetches even on
unchanged quotes. The arbitrage check itself doesn't depend on time to
expiry (it only compares raw bid/ask), so its numbers stay flat between
fetches — recomputing it anyway keeps every output file's timestamp
consistent and is cheap enough not to bother skipping.

A failed fetch or recompute is logged and retried on the next tick rather
than crashing the process — this is meant to be left running unattended.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .arbitrage import DEFAULT_COMMISSION_PER_CONTRACT, check_arbitrage
from .density import breeden_litzenberger_density
from .iv import compute_iv_surface
from .loader import load_snapshot
from .regime import write_regime_summary
from .svi import SVIFit, fit_svi_surface

TICK_SECONDS = 5  # how often the loop wakes up to check what's due


def _log(msg: str) -> None:
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')} UTC] {msg}", flush=True)


def _save(df: pd.DataFrame, path: Path) -> None:
    df.to_parquet(path, index=False)
    df.to_json(path.with_suffix(".json"), orient="records", date_format="iso")


def is_due(last_run: float, now: float, interval: float) -> bool:
    """Pure scheduling check, factored out so it's testable without a real clock."""
    return now - last_run >= interval


def recompute(
    df: pd.DataFrame,
    symbol: str,
    out_dir: Path,
    commission_per_contract: float,
    feed: str,
    valuation_time: datetime | None = None,
) -> dict:
    """Rerun IV -> SVI -> arbitrage against an already-fetched snapshot and

    rewrite the derived output files. Returns the arbitrage summary.
    """
    iv_df = compute_iv_surface(df, valuation_time=valuation_time)
    _save(iv_df, out_dir / f"{symbol}_iv.parquet")

    svi_df = fit_svi_surface(iv_df)
    _save(svi_df, out_dir / f"{symbol}_svi.parquet")

    density_rows = []
    for _, row in svi_df.iterrows():
        fit = SVIFit(
            expiry=row.expiry, forward=row.forward, time_to_expiry=row.time_to_expiry,
            a=row.a, b=row.b, rho=row.rho, m=row.m, sigma=row.sigma,
            n_points=row.n_points, rmse_iv=row.rmse_iv,
        )
        curve = breeden_litzenberger_density(fit)
        curve.insert(0, "expiry", row.expiry)
        density_rows.append(curve)
    density_df = pd.concat(density_rows, ignore_index=True) if density_rows else pd.DataFrame(
        columns=["expiry", "strike", "density", "cdf"]
    )
    _save(density_df, out_dir / f"{symbol}_density.parquet")

    violations, summary = check_arbitrage(df, commission_per_contract=commission_per_contract)
    _save(violations, out_dir / f"{symbol}_arb.parquet")
    summary["meta"] = {
        "symbol": symbol,
        "feed": feed,
        "fetched_at": df["fetched_at"].iloc[0].isoformat() if not df.empty else None,
        "underlying": float(df["underlying"].iloc[0]) if not df.empty else None,
        "computed_at": (valuation_time or datetime.now(timezone.utc)).isoformat(),
    }
    (out_dir / f"{symbol}_arb_summary.json").write_text(json.dumps(summary, indent=2))

    total = summary["total"]
    _log(
        f"recomputed: IV {len(iv_df)} rows, SVI {len(svi_df)} fits, "
        f"arb {total['survive']}/{total['violations']} survive"
    )
    return summary


def run_forever(
    symbol: str,
    out_dir: Path,
    fetch_interval: float,
    recompute_interval: float,
    feed: str,
    max_days_to_expiry: int | None,
    max_spread_pct: float | None,
    commission_per_contract: float,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    df: pd.DataFrame | None = None
    last_fetch = float("-inf")
    last_recompute = float("-inf")

    _log(
        f"starting {symbol}: fetch every {fetch_interval:.0f}s, "
        f"recompute every {recompute_interval:.0f}s ({feed} feed, Ctrl+C to stop)"
    )
    if recompute_interval > fetch_interval:
        _log("note: recompute-interval > fetch-interval, so every recompute will follow a fresh fetch anyway")

    while True:
        now = time.monotonic()

        if is_due(last_fetch, now, fetch_interval):
            try:
                df = load_snapshot(
                    symbol, feed=feed, max_days_to_expiry=max_days_to_expiry, max_spread_pct=max_spread_pct
                )
                _save(df, out_dir / f"{symbol}_snapshot.parquet")
                last_fetch = now
                _log(f"fetched {len(df)} clean quotes ({feed} feed)")
                try:
                    regime = write_regime_summary(symbol, out_dir)
                    _log(f"regime: {regime.current_regime} (realized vol {regime.current_vol:.1%})")
                except Exception as e:  # noqa: BLE001 - a slow/failed history pull shouldn't block the rest
                    _log(f"regime detection failed, keeping last known: {e}")
                recompute(df, symbol, out_dir, commission_per_contract, feed)
                last_recompute = now
            except Exception as e:  # noqa: BLE001 - meant to run unattended
                _log(f"fetch failed, retrying next tick: {e}")
        elif df is not None and is_due(last_recompute, now, recompute_interval):
            try:
                recompute(df, symbol, out_dir, commission_per_contract, feed, valuation_time=datetime.now(timezone.utc))
                last_recompute = now
            except Exception as e:  # noqa: BLE001
                _log(f"recompute failed, retrying next tick: {e}")

        time.sleep(TICK_SECONDS)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--symbol", default="SPY")
    parser.add_argument("--out-dir", default="data")
    parser.add_argument("--feed", choices=["indicative", "opra"], default="indicative")
    parser.add_argument("--max-days-to-expiry", type=int, default=60)
    parser.add_argument("--max-spread-pct", type=float, default=None)
    parser.add_argument("--commission-per-contract", type=float, default=DEFAULT_COMMISSION_PER_CONTRACT)
    parser.add_argument("--fetch-interval", type=float, default=300, help="Seconds between Alpaca fetches (default 300 = 5 min).")
    parser.add_argument("--recompute-interval", type=float, default=120, help="Seconds between recomputes (default 120 = 2 min).")
    args = parser.parse_args()

    run_forever(
        symbol=args.symbol.upper(),
        out_dir=Path(args.out_dir),
        fetch_interval=args.fetch_interval,
        recompute_interval=args.recompute_interval,
        feed=args.feed,
        max_days_to_expiry=args.max_days_to_expiry or None,
        max_spread_pct=args.max_spread_pct,
        commission_per_contract=args.commission_per_contract,
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped.")
