"""Build a strike-level IV surface: one row per (expiry, strike), with the
implied vol inverted separately from the bid and the ask — so every strike
carries an IV range, not just a single point estimate from the mid.

Per expiry: estimate the forward/discount factor from put-call parity, then
for each strike use whichever leg is out-of-the-money (calls above the
forward, puts below). OTM options are used because ITM inversion is
numerically ill-conditioned — an ITM price is dominated by intrinsic value,
so small quote noise maps to a huge range of vol.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pandas as pd

from .forward import estimate_forward
from .pricing import implied_vol


def _time_to_expiry_years(expiry: pd.Timestamp, valuation_time: datetime) -> float:
    # Approximate US market close (4pm ET) as 20:00 UTC; ignores DST, fine
    # for a days-to-weeks horizon.
    expiry_close = expiry.tz_localize("UTC") + timedelta(hours=20)
    return (expiry_close - valuation_time).total_seconds() / (365.0 * 24 * 3600)


def compute_iv_surface(df: pd.DataFrame, valuation_time: datetime | None = None) -> pd.DataFrame:
    """Return a strike-level IV surface from a cleaned long-form quote table.

    Columns: expiry, strike, option_type (the OTM leg used), forward,
    discount_factor, time_to_expiry, bid, ask, mid, iv_bid, iv_mid, iv_ask.
    """
    columns = [
        "expiry", "strike", "option_type", "forward", "discount_factor",
        "time_to_expiry", "bid", "ask", "mid", "iv_bid", "iv_mid", "iv_ask",
    ]
    if df.empty:
        return pd.DataFrame(columns=columns)

    if valuation_time is None:
        valuation_time = df["fetched_at"].iloc[0]
    if valuation_time.tzinfo is None:
        valuation_time = valuation_time.replace(tzinfo=timezone.utc)

    rows = []
    for expiry, group in df.groupby("expiry"):
        calls = group[group["option_type"] == "CE"].set_index("strike")
        puts = group[group["option_type"] == "PE"].set_index("strike")
        common = calls.index.intersection(puts.index)

        forward, discount_factor = estimate_forward(
            common.to_numpy(),
            calls.loc[common, "mid"].to_numpy(),
            puts.loc[common, "mid"].to_numpy(),
        )
        time_to_expiry = _time_to_expiry_years(expiry, valuation_time)

        all_strikes = sorted(set(calls.index) | set(puts.index))
        for strike in all_strikes:
            use_call = strike >= forward if pd.notna(forward) else strike >= group["underlying"].iloc[0]
            leg, option_type = (calls, "CE") if use_call else (puts, "PE")
            if strike not in leg.index:
                continue  # OTM side has no surviving (clean) quote at this strike

            quote = leg.loc[strike]
            iv_bid = implied_vol(quote["bid"], forward, strike, time_to_expiry, option_type, discount_factor)
            iv_mid = implied_vol(quote["mid"], forward, strike, time_to_expiry, option_type, discount_factor)
            iv_ask = implied_vol(quote["ask"], forward, strike, time_to_expiry, option_type, discount_factor)

            rows.append(
                {
                    "expiry": expiry,
                    "strike": strike,
                    "option_type": option_type,
                    "forward": forward,
                    "discount_factor": discount_factor,
                    "time_to_expiry": time_to_expiry,
                    "bid": quote["bid"],
                    "ask": quote["ask"],
                    "mid": quote["mid"],
                    "iv_bid": iv_bid,
                    "iv_mid": iv_mid,
                    "iv_ask": iv_ask,
                }
            )

    return pd.DataFrame(rows, columns=columns).sort_values(["expiry", "strike"]).reset_index(drop=True)
