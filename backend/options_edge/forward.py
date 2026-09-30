"""Synthetic forward + discount factor from put-call parity.

Put-call parity: ``C - P = D * (F - K)`` for European options, where
``D = e^{-rT}`` is the discount factor and ``F`` the forward. Rearranged,
``(C - P) = D*F - D*K`` is linear in strike ``K``, so a least-squares fit
across strikes at one expiry recovers both ``D`` (the slope) and ``F``
(intercept / slope) without needing an external risk-free rate or dividend
yield — the standard trick (also how CBOE computes the VIX forward).
"""

from __future__ import annotations

import numpy as np


def estimate_forward(
    strikes: np.ndarray, call_mids: np.ndarray, put_mids: np.ndarray
) -> tuple[float, float]:
    """Return ``(forward, discount_factor)`` from parity across strikes.

    Needs at least 2 strikes with both a call and put mid price, spanning a
    non-zero strike range. Returns ``(nan, nan)`` otherwise, or if the fit is
    degenerate (non-positive discount factor).
    """
    strikes = np.asarray(strikes, dtype=float)
    y = np.asarray(call_mids, dtype=float) - np.asarray(put_mids, dtype=float)
    mask = np.isfinite(strikes) & np.isfinite(y)
    strikes, y = strikes[mask], y[mask]

    if len(strikes) < 2 or np.ptp(strikes) == 0:
        return float("nan"), float("nan")

    slope, intercept = np.polyfit(strikes, y, 1)
    discount_factor = -slope
    if discount_factor <= 0:
        return float("nan"), float("nan")

    forward = intercept / discount_factor
    if forward <= 0:
        return float("nan"), float("nan")

    return float(forward), float(discount_factor)
