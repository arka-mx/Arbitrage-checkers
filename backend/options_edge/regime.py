"""Realized volatility and volatility-regime detection for the underlying.

Pulls up to two years of daily bars from Alpaca, computes a 30-day rolling
realized (close-to-close) volatility, and buckets each day into a regime —
low / medium / high — by where its trailing realized vol sits against the
*whole two-year history's own* distribution (tertiles). The regime the most
recent day falls into, and that regime's own historical mean/std of vol, is
what the payoff projection uses to simulate forward paths: not a single
flat "today's vol forever" assumption, but "when the market has looked like
this before, here's how it actually moved."

This module never persists raw daily prices — only the regime summary
(labels, per-regime vol stats, and the day-count each regime has held for)
is written out, since the point is what *regime* SPY is in, not a replay of
two years of closing prices.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from alpaca.data.historical.stock import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame

TRADING_DAYS_PER_YEAR = 252
REALIZED_VOL_WINDOW = 30
REGIME_LABELS = ("low", "medium", "high")


def _credentials() -> tuple[str, str]:
    api_key = os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY_ID")
    secret_key = os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_API_SECRET_KEY")
    if not api_key or not secret_key:
        raise RuntimeError(
            "Alpaca credentials not found. Set APCA_API_KEY_ID and "
            "APCA_API_SECRET_KEY (a backend/.env file is picked up automatically)."
        )
    return api_key, secret_key


def fetch_daily_bars(symbol: str, lookback_days: int = 730) -> pd.DataFrame:
    """Daily OHLCV bars for ``symbol`` over the trailing ``lookback_days``."""
    api_key, secret_key = _credentials()
    client = StockHistoricalDataClient(api_key, secret_key)
    request = StockBarsRequest(
        symbol_or_symbols=symbol,
        timeframe=TimeFrame.Day,
        start=datetime.now(timezone.utc) - timedelta(days=lookback_days),
    )
    bars = client.get_stock_bars(request).df
    if bars.empty:
        return pd.DataFrame(columns=["timestamp", "close"])
    bars = bars.reset_index()
    return bars[["timestamp", "close"]].sort_values("timestamp").reset_index(drop=True)


def realized_vol(closes: pd.Series, window: int = REALIZED_VOL_WINDOW) -> pd.Series:
    """Annualized close-to-close realized vol, trailing ``window`` trading days."""
    log_returns = np.log(closes / closes.shift(1))
    return log_returns.rolling(window).std() * np.sqrt(TRADING_DAYS_PER_YEAR)


@dataclass
class RegimeStats:
    label: str
    vol_mean: float
    vol_std: float
    days: int


@dataclass
class RegimeSummary:
    symbol: str
    computed_at: str
    lookback_days: int
    current_regime: str
    current_vol: float
    regimes: list[RegimeStats]
    daily_drift: float  # mean daily log return over the lookback (for the simulator's drift term)

    def to_json(self) -> dict:
        d = asdict(self)
        return d


def detect_regime(symbol: str, lookback_days: int = 730) -> RegimeSummary:
    """Fetch history, compute rolling realized vol, and bucket it into
    low/medium/high regimes by tertiles of its own two-year distribution."""
    bars = fetch_daily_bars(symbol, lookback_days)
    if len(bars) < REALIZED_VOL_WINDOW + 10:
        raise RuntimeError(f"Not enough daily bars for {symbol} to compute a realized-vol regime.")

    closes = bars["close"]
    vol = realized_vol(closes).dropna()
    log_returns = np.log(closes / closes.shift(1)).dropna()

    q1, q2 = vol.quantile([1 / 3, 2 / 3])
    labels = pd.cut(vol, bins=[-np.inf, q1, q2, np.inf], labels=REGIME_LABELS)

    regimes = []
    for label in REGIME_LABELS:
        in_regime = vol[labels == label]
        regimes.append(
            RegimeStats(
                label=label,
                vol_mean=float(in_regime.mean()),
                vol_std=float(in_regime.std(ddof=0)) if len(in_regime) > 1 else 0.0,
                days=int(len(in_regime)),
            )
        )

    current_label = str(labels.iloc[-1])
    current_vol = float(vol.iloc[-1])

    return RegimeSummary(
        symbol=symbol,
        computed_at=datetime.now(timezone.utc).isoformat(),
        lookback_days=lookback_days,
        current_regime=current_label,
        current_vol=current_vol,
        regimes=regimes,
        daily_drift=float(log_returns.mean()),
    )


def write_regime_summary(symbol: str, out_dir: Path, lookback_days: int = 730) -> RegimeSummary:
    summary = detect_regime(symbol, lookback_days)
    (out_dir / f"{symbol}_regime.json").write_text(json.dumps(summary.to_json(), indent=2))
    return summary
