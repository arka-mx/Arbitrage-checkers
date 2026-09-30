from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

from options_edge.iv import compute_iv_surface
from options_edge.pricing import black76_price


def build_snapshot_df(forward, discount, true_vol, strikes, t, valuation_time, spread_frac=0.02):
    expiry = valuation_time + pd.Timedelta(days=int(t * 365))
    rows = []
    for strike in strikes:
        for option_type in ("CE", "PE"):
            mid = black76_price(forward, strike, t, true_vol, option_type, discount)
            half_spread = max(mid * spread_frac, 0.01)
            bid, ask = mid - half_spread, mid + half_spread
            rows.append(
                {
                    "occ_symbol": f"TEST{strike}{option_type}",
                    "expiry": pd.Timestamp(expiry.date()),
                    "strike": float(strike),
                    "option_type": option_type,
                    "bid": bid,
                    "ask": ask,
                    "mid": mid,
                    "underlying": forward,
                    "fetched_at": valuation_time,
                }
            )
    return pd.DataFrame(rows)


@pytest.fixture
def valuation_time():
    return datetime(2024, 1, 2, tzinfo=timezone.utc)


def test_compute_iv_surface_recovers_flat_vol(valuation_time):
    forward, discount, true_vol, t = 565.0, 0.995, 0.20, 30 / 365
    strikes = [540, 550, 560, 565, 570, 580, 590]
    df = build_snapshot_df(forward, discount, true_vol, strikes, t, valuation_time)

    surface = compute_iv_surface(df, valuation_time=valuation_time)

    assert len(surface) == len(strikes)
    assert surface["forward"].iloc[0] == pytest.approx(forward, abs=0.5)
    assert surface["iv_mid"].dropna().apply(lambda v: v == pytest.approx(true_vol, abs=0.01)).all()


def test_compute_iv_surface_uses_otm_leg(valuation_time):
    forward, discount, true_vol, t = 565.0, 0.995, 0.20, 30 / 365
    strikes = [540, 590]
    df = build_snapshot_df(forward, discount, true_vol, strikes, t, valuation_time)
    surface = compute_iv_surface(df, valuation_time=valuation_time)

    below = surface[surface["strike"] == 540].iloc[0]
    above = surface[surface["strike"] == 590].iloc[0]
    assert below["option_type"] == "PE"
    assert above["option_type"] == "CE"


def test_compute_iv_surface_bid_ask_iv_bracket_mid(valuation_time):
    forward, discount, true_vol, t = 565.0, 0.995, 0.20, 30 / 365
    strikes = [540, 550, 560, 565, 570, 580, 590]
    df = build_snapshot_df(forward, discount, true_vol, strikes, t, valuation_time)
    surface = compute_iv_surface(df, valuation_time=valuation_time).dropna(
        subset=["iv_bid", "iv_mid", "iv_ask"]
    )
    assert (surface["iv_bid"] <= surface["iv_mid"] + 1e-9).all()
    assert (surface["iv_mid"] <= surface["iv_ask"] + 1e-9).all()


def test_compute_iv_surface_empty_input_returns_empty():
    result = compute_iv_surface(pd.DataFrame())
    assert result.empty
    assert list(result.columns) == [
        "expiry", "strike", "option_type", "forward", "discount_factor",
        "time_to_expiry", "bid", "ask", "mid", "iv_bid", "iv_mid", "iv_ask",
    ]


def test_compute_iv_surface_skips_strike_missing_otm_leg(valuation_time):
    forward, discount, true_vol, t = 565.0, 0.995, 0.20, 30 / 365
    strikes = [540, 550, 560, 570, 580]
    df = build_snapshot_df(forward, discount, true_vol, strikes, t, valuation_time)
    # Drop the OTM put at strike 550 (put-side, below forward) — that strike
    # should disappear from the surface since its OTM leg has no quote.
    df = df[~((df["strike"] == 550) & (df["option_type"] == "PE"))]

    surface = compute_iv_surface(df, valuation_time=valuation_time)
    assert 550 not in set(surface["strike"])
