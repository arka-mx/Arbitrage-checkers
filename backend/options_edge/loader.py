"""Turn a fetched Alpaca options chain into a clean, long-form quote table.

Long-form: one row per (expiry, strike, option_type), which is the shape
later stages (IV inversion per strike, SVI fits per expiry) want.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from .alpaca_client import RawChain


def raw_to_frame(
    raw: RawChain, underlying_price: float | None = None, feed: str | None = None
) -> pd.DataFrame:
    """Join contract metadata with quotes into a long-form DataFrame.

    Columns: occ_symbol, root_symbol, expiry, strike, option_type, bid, ask,
    bid_size, ask_size, quote_time, ltp, oi, alpaca_iv, underlying, feed,
    fetched_at. ``feed`` is carried on every row so no downstream number can
    be quoted without its data source.
    """
    rows = []
    fetched_at = datetime.now(timezone.utc)

    for contract in raw.contracts:
        snapshot = raw.quotes.get(contract.symbol)
        quote = snapshot.latest_quote if snapshot is not None else None
        trade = snapshot.latest_trade if snapshot is not None else None

        rows.append(
            {
                "occ_symbol": contract.symbol,
                "root_symbol": contract.root_symbol,
                "expiry": contract.expiration_date,
                "strike": float(contract.strike_price),
                "option_type": "CE" if contract.type.value == "call" else "PE",
                "bid": quote.bid_price if quote else None,
                "ask": quote.ask_price if quote else None,
                "bid_size": quote.bid_size if quote else None,
                "ask_size": quote.ask_size if quote else None,
                "quote_time": getattr(quote, "timestamp", None) if quote else None,
                "ltp": trade.price if trade else None,
                "oi": contract.open_interest,
                "alpaca_iv": snapshot.implied_volatility if snapshot else None,
                "underlying": underlying_price,
                "feed": feed,
                "fetched_at": fetched_at,
            }
        )

    df = pd.DataFrame(rows)
    if df.empty:
        return df

    df["expiry"] = pd.to_datetime(df["expiry"])
    df["quote_time"] = pd.to_datetime(df["quote_time"], utc=True)
    numeric_cols = ["strike", "bid", "ask", "bid_size", "ask_size", "ltp", "oi", "alpaca_iv"]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    return df.sort_values(["expiry", "strike", "option_type"]).reset_index(drop=True)


def clean(df: pd.DataFrame, max_spread_pct: float | None = None) -> pd.DataFrame:
    """Drop stale/zero-bid quotes and add mid/spread columns.

    A quote is dropped when:
      - bid or ask is missing, zero, or negative (no live two-sided market), or
      - bid > ask (crossed/stale book).

    ``max_spread_pct`` optionally drops quotes whose spread, as a fraction of
    mid, exceeds the threshold (e.g. 0.5 for 50%) — useful for far OTM/illiquid
    contracts that still print a two-sided quote but aren't tradeable.
    """
    if df.empty:
        return df.assign(mid=[], spread=[], spread_pct=[])

    out = df.copy()
    has_two_sided_quote = (
        out["bid"].notna()
        & out["ask"].notna()
        & (out["bid"] > 0)
        & (out["ask"] > 0)
        & (out["bid"] <= out["ask"])
    )
    out = out.loc[has_two_sided_quote].copy()

    out["mid"] = (out["bid"] + out["ask"]) / 2
    out["spread"] = out["ask"] - out["bid"]
    out["spread_pct"] = out["spread"] / out["mid"]

    if max_spread_pct is not None:
        out = out.loc[out["spread_pct"] <= max_spread_pct]

    return out.reset_index(drop=True)


def load_snapshot(
    symbol: str = "SPY",
    max_spread_pct: float | None = None,
    max_days_to_expiry: int | None = 60,
    feed: str = "indicative",
) -> pd.DataFrame:
    """Fetch, flatten, and clean a live option-chain snapshot for ``symbol``.

    ``feed`` is "opra" (real consolidated quotes) or "indicative" (Alpaca's
    free derived feed).
    """
    from datetime import date, timedelta

    from alpaca.data.enums import OptionsFeed
    from alpaca.data.historical.stock import StockHistoricalDataClient
    from alpaca.data.requests import StockLatestTradeRequest

    from .alpaca_client import AlpacaOptionsClient, _credentials

    client = AlpacaOptionsClient()

    expiration_date_lte = (
        date.today() + timedelta(days=max_days_to_expiry) if max_days_to_expiry else None
    )
    raw = client.fetch_chain(
        symbol, expiration_date_lte=expiration_date_lte, feed=OptionsFeed(feed)
    )

    api_key, secret_key = _credentials()
    stock_client = StockHistoricalDataClient(api_key, secret_key)
    latest_trade = stock_client.get_stock_latest_trade(
        StockLatestTradeRequest(symbol_or_symbols=symbol)
    )
    underlying_price = float(latest_trade[symbol].price)

    frame = raw_to_frame(raw, underlying_price=underlying_price, feed=feed)
    return clean(frame, max_spread_pct=max_spread_pct)
