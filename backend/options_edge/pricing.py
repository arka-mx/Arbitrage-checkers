"""Black-76 (forward-measure Black-Scholes) pricing and IV inversion.

We price off a forward ``F`` and discount factor ``D`` (see ``forward.py``)
rather than spot + a risk-free rate + a dividend yield: for index options,
the forward/discount pair is extractable directly from put-call parity, so
we don't need an external rate or dividend estimate to get a clean IV.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.optimize import brentq
from scipy.stats import norm


def black76_price(
    forward: float,
    strike: float,
    time_to_expiry: float,
    vol: float,
    option_type: str,
    discount_factor: float = 1.0,
) -> float:
    """Price a European option under Black-76. ``option_type`` is "CE" or "PE"."""
    intrinsic = max(forward - strike, 0.0) if option_type == "CE" else max(strike - forward, 0.0)
    if time_to_expiry <= 0 or vol <= 0:
        return discount_factor * intrinsic

    sqrt_t = math.sqrt(time_to_expiry)
    d1 = (math.log(forward / strike) + 0.5 * vol * vol * time_to_expiry) / (vol * sqrt_t)
    d2 = d1 - vol * sqrt_t

    if option_type == "CE":
        undiscounted = forward * norm.cdf(d1) - strike * norm.cdf(d2)
    else:
        undiscounted = strike * norm.cdf(-d2) - forward * norm.cdf(-d1)
    return discount_factor * undiscounted


def black76_delta(
    forward: float,
    strike: float,
    time_to_expiry: float,
    vol: float,
    option_type: str,
    discount_factor: float = 1.0,
) -> float:
    """dPrice/dForward under Black-76: in [0, D] for a call, [-D, 0] for a put.

    Used by the hedging simulator with ``forward`` set to (array-valued) spot
    prices and ``discount_factor=1`` — Black-76 with F=S, D=1 is exactly
    Black-Scholes with r=0, q=0, so this doubles as the spot delta for that
    case. Accepts numpy arrays for ``forward`` (and/or ``time_to_expiry``) so
    it vectorizes across simulated paths.
    """
    forward = np.asarray(forward, dtype=float)
    step = discount_factor if option_type == "CE" else -discount_factor
    zero_step = 0.0 if option_type == "CE" else -discount_factor
    degenerate_value = np.where(forward > strike, step, zero_step)

    sqrt_t = np.sqrt(np.maximum(time_to_expiry, 1e-300))
    with np.errstate(divide="ignore", invalid="ignore"):
        d1 = (np.log(forward / strike) + 0.5 * vol * vol * time_to_expiry) / (vol * sqrt_t)
    delta = discount_factor * (norm.cdf(d1) if option_type == "CE" else norm.cdf(d1) - 1)

    degenerate = np.logical_or(np.asarray(time_to_expiry) <= 0, vol <= 0)
    result = np.where(degenerate, degenerate_value, delta)
    return float(result) if result.ndim == 0 else result


def implied_vol(
    price: float,
    forward: float,
    strike: float,
    time_to_expiry: float,
    option_type: str,
    discount_factor: float = 1.0,
    lo: float = 1e-4,
    hi: float = 5.0,
) -> float:
    """Invert Black-76 for ``vol``. Returns NaN if ``price`` isn't reachable

    within ``[lo, hi]`` vol — e.g. a stale/crossed quote, or a price outside
    the no-arbitrage bounds implied by ``forward``/``discount_factor``.
    """
    if (
        price is None
        or forward is None
        or not math.isfinite(price)
        or not math.isfinite(forward)
        or time_to_expiry <= 0
        or strike <= 0
        or forward <= 0
    ):
        return float("nan")

    def objective(vol: float) -> float:
        return black76_price(forward, strike, time_to_expiry, vol, option_type, discount_factor) - price

    f_lo, f_hi = objective(lo), objective(hi)
    if f_lo == 0:
        return lo
    if f_hi == 0:
        return hi
    if f_lo * f_hi > 0:
        return float("nan")

    return brentq(objective, lo, hi, xtol=1e-6, rtol=1e-8, maxiter=100)
