"""CLI: fetch an option-chain snapshot from Alpaca and run the pipeline on it.

    python -m options_edge.cli --symbol SPY --also-json --svi --arb

Needs Alpaca credentials: set APCA_API_KEY_ID and APCA_API_SECRET_KEY, either
as environment variables or in a backend/.env file (picked up automatically).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from .arbitrage import DEFAULT_COMMISSION_PER_CONTRACT, check_arbitrage
from .density import breeden_litzenberger_density
from .iv import compute_iv_surface
from .loader import load_snapshot
from .regime import write_regime_summary
from .svi import SVIFit, fit_svi_surface


def _save(df: pd.DataFrame, path: Path, also_json: bool) -> None:
    df.to_parquet(path, index=False)
    print(f"wrote {len(df)} rows to {path}")
    if also_json:
        df.to_json(path.with_suffix(".json"), orient="records", date_format="iso")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbol", default="SPY", help="Underlying ticker, e.g. SPY, QQQ.")
    parser.add_argument("--out-dir", default="data")
    parser.add_argument(
        "--max-spread-pct",
        type=float,
        default=None,
        help="Drop quotes whose spread exceeds this fraction of mid (e.g. 0.5).",
    )
    parser.add_argument(
        "--max-days-to-expiry",
        type=int,
        default=60,
        help="Only fetch contracts expiring within this many days (default 60). "
        "Pass 0 to fetch every listed expiry.",
    )
    parser.add_argument(
        "--feed",
        choices=["indicative", "opra"],
        default="indicative",
        help="Options quote feed. 'opra' is the real consolidated tape (requires the "
        "OPRA agreement in your Alpaca dashboard); 'indicative' is Alpaca's free "
        "derived feed — not the real NBBO (default: indicative).",
    )
    parser.add_argument(
        "--also-json",
        action="store_true",
        help="Also write a .json copy of each output, for the Next.js frontend.",
    )
    parser.add_argument(
        "--iv",
        action="store_true",
        help="Invert bid/mid/ask IV per strike (OTM leg, forward from put-call parity).",
    )
    parser.add_argument(
        "--svi",
        action="store_true",
        help="Fit raw SVI (5 params) per expiry to the mid IVs. Implies --iv.",
    )
    parser.add_argument(
        "--arb",
        action="store_true",
        help="Check butterfly and calendar no-arbitrage on the quotes, before and "
        "after crossing the bid-ask on every leg.",
    )
    parser.add_argument(
        "--regime",
        action="store_true",
        help="Pull ~2y of daily bars and detect the current realized-volatility regime "
        "(low/medium/high), for the payoff projection's Monte Carlo simulation.",
    )
    parser.add_argument(
        "--density",
        action="store_true",
        help="Breeden-Litzenberger risk-neutral density per expiry, from the fitted SVI "
        "smile (probability of the underlying finishing at each price). Implies --svi.",
    )
    parser.add_argument(
        "--commission-per-contract",
        type=float,
        default=DEFAULT_COMMISSION_PER_CONTRACT,
        help=f"Broker commission + regulatory fees per option contract per leg, "
        f"charged on every arbitrage leg (default ${DEFAULT_COMMISSION_PER_CONTRACT:.2f}, "
        "illustrative — set to your own broker's actual rate). Pass 0 to exclude it.",
    )
    args = parser.parse_args()

    symbol = args.symbol.upper()
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    df = load_snapshot(
        symbol,
        max_spread_pct=args.max_spread_pct,
        max_days_to_expiry=args.max_days_to_expiry or None,
        feed=args.feed,
    )
    _save(df, out_dir / f"{symbol}_snapshot.parquet", args.also_json)

    if args.iv or args.svi or args.density:
        iv_df = compute_iv_surface(df)
        _save(iv_df, out_dir / f"{symbol}_iv.parquet", args.also_json)

    if args.svi or args.density:
        svi_df = fit_svi_surface(iv_df)
        _save(svi_df, out_dir / f"{symbol}_svi.parquet", args.also_json)

    if args.density:
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
        _save(density_df, out_dir / f"{symbol}_density.parquet", args.also_json)

    if args.regime:
        try:
            regime = write_regime_summary(symbol, out_dir)
            print(f"regime: {regime.current_regime} (realized vol {regime.current_vol:.1%})")
        except Exception as exc:  # noqa: BLE001 - a slow/failed history pull shouldn't kill the whole run
            print(f"regime detection skipped: {exc}")

    if args.arb:
        violations, summary = check_arbitrage(df, commission_per_contract=args.commission_per_contract)
        _save(violations, out_dir / f"{symbol}_arb.parquet", args.also_json)
        summary["meta"] = {
            "symbol": symbol,
            "feed": args.feed,
            "fetched_at": df["fetched_at"].iloc[0].isoformat() if not df.empty else None,
            "underlying": float(df["underlying"].iloc[0]) if not df.empty else None,
        }
        (out_dir / f"{symbol}_arb_summary.json").write_text(json.dumps(summary, indent=2))
        total = summary["total"]
        print(
            f"\n[{args.feed} feed, ${args.commission_per_contract:.2f}/contract commission] "
            f"{total['violations']} violations found, "
            f"{total['survive']} survive costs (out of {total['checked']} checks)"
        )
        for kind in ("butterfly", "calendar"):
            s = summary[kind]
            print(f"  {kind:<10} {s['violations']:>5} found  {s['survive']:>4} survive  / {s['checked']} checked")
        if args.feed == "indicative":
            print(
                "\n  CAUTION: indicative quotes are Alpaca-derived, not the real NBBO. "
                "Survivors here are\n  not evidence of tradeable arbitrage; rerun with "
                "--feed opra for a real answer."
            )


if __name__ == "__main__":
    main()
