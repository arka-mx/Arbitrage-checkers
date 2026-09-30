"""Static no-arbitrage checks on the quoted surface, before and after costs.

A *violation* is a condition that fails at mid prices. It *survives costs* if
it still fails when every leg is crossed — bought at the ask, sold at the bid
— and every leg's broker commission is subtracted too. Since bid <= mid <=
ask and commission >= 0, every survivor is also a violation.

Checks run on market quotes, not on the SVI fit: a model surface can't be
traded, so an arbitrage only counts if the quotes themselves offer it.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

VIOLATION_COLUMNS = [
    "kind", "option_type", "expiry", "expiry_far", "k1", "k2", "k3",
    "mid_value", "exec_value", "commission", "survives", "leg_time_skew_s",
]

# Illustrative, not fetched from any broker's live fee schedule — same spirit
# as hedging.py's half_spread default: a placeholder you're expected to set
# to your own broker's actual rate. $0.65/contract was a common retail
# options commission for years; many brokers (Alpaca included) now charge
# $0 commission but still pass through small regulatory fees (OCC, SEC,
# exchange) on the order of a few cents per contract — this one flat number
# stands in for "commission + regulatory pass-through," combined for
# simplicity rather than split into three separate, harder-to-source figures.
DEFAULT_COMMISSION_PER_CONTRACT = 0.65


def _time_skew_seconds(*times: np.ndarray) -> np.ndarray:
    """Spread between the oldest and newest quote across legs, in seconds."""
    stacked = np.stack([t.astype("datetime64[ns]").astype("int64") for t in times])
    missing = np.stack([np.isnat(t.astype("datetime64[ns]")) for t in times]).any(axis=0)
    skew = (stacked.max(axis=0) - stacked.min(axis=0)) / 1e9
    return np.where(missing, np.nan, skew)


def _quote_times(g: pd.DataFrame) -> np.ndarray:
    if "quote_time" not in g:
        return np.full(len(g), np.datetime64("NaT"), dtype="datetime64[ns]")
    return g["quote_time"].dt.tz_convert(None).to_numpy(dtype="datetime64[ns]")


def butterfly_violations(
    df: pd.DataFrame, tol: float = 1e-9, commission_per_contract: float = 0.0
) -> tuple[pd.DataFrame, int]:
    """Convexity in strike, per expiry and option type, on adjacent strikes.

    For K1 < K2 < K3 with lam = (K3 - K2) / (K3 - K1), the butterfly
    ``lam*P(K1) - P(K2) + (1 - lam)*P(K3)`` has a non-negative payoff, so its
    price must be >= 0. Holds for American options too. Adjacent triples are
    sufficient: a piecewise-linear price curve is convex iff every adjacent
    triple is.

    Cost-adjusted value buys the wings at the ask and sells the body at the
    bid, then subtracts ``commission_per_contract`` for every contract
    traded — the wings' weights (lam, 1-lam) plus the body's 1 always sum to
    2, so the commission is exactly ``2 * commission_per_contract``
    regardless of strike spacing. Returns ``(violations, n_checked)``.
    """
    rows = []
    n_checked = 0
    commission = 2 * commission_per_contract
    for (expiry, option_type), g in df.groupby(["expiry", "option_type"]):
        g = g.sort_values("strike")
        if len(g) < 3:
            continue

        k = g["strike"].to_numpy()
        bid, ask, mid = (g[c].to_numpy() for c in ("bid", "ask", "mid"))
        t = _quote_times(g)
        k1, k2, k3 = k[:-2], k[1:-1], k[2:]
        lam = (k3 - k2) / (k3 - k1)

        mid_value = lam * mid[:-2] - mid[1:-1] + (1 - lam) * mid[2:]
        exec_value = lam * ask[:-2] - bid[1:-1] + (1 - lam) * ask[2:] + commission
        skew = _time_skew_seconds(t[:-2], t[1:-1], t[2:])
        n_checked += len(mid_value)

        for i in np.flatnonzero(mid_value < -tol):
            rows.append(
                {
                    "kind": "butterfly", "option_type": option_type,
                    "expiry": expiry, "expiry_far": pd.NaT,
                    "k1": k1[i], "k2": k2[i], "k3": k3[i],
                    "mid_value": mid_value[i], "exec_value": exec_value[i],
                    "commission": commission,
                    "survives": bool(exec_value[i] < -tol),
                    "leg_time_skew_s": skew[i],
                }
            )

    return pd.DataFrame(rows, columns=VIOLATION_COLUMNS), n_checked


def calendar_violations(
    df: pd.DataFrame, tol: float = 1e-9, commission_per_contract: float = 0.0
) -> tuple[pd.DataFrame, int]:
    """Monotonicity in maturity, per strike and option type, over all expiry pairs.

    For T1 < T2, ``P(K, T2) - P(K, T1) >= 0``. This is model-free for
    American options (SPY): the longer option can be exercised whenever the
    shorter one can. (For European options on a dividend payer it is not —
    that check would have to be done in forward-moneyness instead.)

    All pairs, not just adjacent ones: once costs are included, a far pair can
    survive even when neither adjacent pair does. Cost-adjusted value buys the
    far leg at the ask and sells the near leg at the bid, then subtracts
    ``2 * commission_per_contract`` for the two contracts traded. Returns
    ``(violations, n_checked)``.
    """
    rows = []
    n_checked = 0
    commission = 2 * commission_per_contract
    for (option_type, strike), g in df.groupby(["option_type", "strike"]):
        g = g.sort_values("expiry")
        if len(g) < 2:
            continue

        expiry = g["expiry"].to_numpy()
        bid, ask, mid = (g[c].to_numpy() for c in ("bid", "ask", "mid"))
        t = _quote_times(g)
        near, far = np.triu_indices(len(g), k=1)

        mid_value = mid[far] - mid[near]
        exec_value = ask[far] - bid[near] + commission
        skew = _time_skew_seconds(t[near], t[far])
        n_checked += len(mid_value)

        for i in np.flatnonzero(mid_value < -tol):
            rows.append(
                {
                    "kind": "calendar", "option_type": option_type,
                    "expiry": pd.Timestamp(expiry[near[i]]),
                    "expiry_far": pd.Timestamp(expiry[far[i]]),
                    "k1": strike, "k2": np.nan, "k3": np.nan,
                    "mid_value": mid_value[i], "exec_value": exec_value[i],
                    "commission": commission,
                    "survives": bool(exec_value[i] < -tol),
                    "leg_time_skew_s": skew[i],
                }
            )

    return pd.DataFrame(rows, columns=VIOLATION_COLUMNS), n_checked


def check_arbitrage(
    df: pd.DataFrame, tol: float = 1e-9, commission_per_contract: float = 0.0
) -> tuple[pd.DataFrame, dict]:
    """Run both checks. Returns ``(violations, summary)``.

    ``summary`` has, per kind and in total: ``checked``, ``violations``
    (fail at mid), and ``survive`` (still fail with every leg crossed and
    every leg's commission paid).
    """
    fly, fly_checked = butterfly_violations(df, tol, commission_per_contract)
    cal, cal_checked = calendar_violations(df, tol, commission_per_contract)
    parts = [p for p in (fly, cal) if not p.empty]
    violations = (
        pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=VIOLATION_COLUMNS)
    )

    def counts(v: pd.DataFrame, checked: int) -> dict:
        return {"checked": checked, "violations": len(v), "survive": int(v["survives"].sum())}

    summary = {
        "butterfly": counts(fly, fly_checked),
        "calendar": counts(cal, cal_checked),
        "total": counts(violations, fly_checked + cal_checked),
        "commission_per_contract": commission_per_contract,
    }
    return violations, summary
