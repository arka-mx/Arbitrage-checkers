"""Breeden-Litzenberger: the market's own risk-neutral probability density
for where the underlying finishes at expiry, extracted from the fitted IV
smile.

A European call's price is C(K) = D * E[max(S_T - K, 0)] under the forward
measure. Differentiating twice with respect to strike recovers the
risk-neutral density of S_T:

    f(K) = D^-1 * d^2C/dK^2        (Breeden & Litzenberger, 1978)

We price C(K) with Black-76 off the fitted SVI smile (so the *entire* curve
is implied, not just the handful of strikes actually quoted), differentiate
numerically on a fine strike grid, clip the inevitable small negative noise
from finite differences to zero, and rescale so it integrates to 1 — the
smile was fit to bid/ask mids, not free of arbitrage by construction, so a
tiny renormalization is expected and honest to apply rather than ignore.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.integrate import cumulative_trapezoid

from .pricing import black76_price
from .svi import SVIFit

N_GRID = 400
LOG_MONEYNESS_RANGE = 1.2  # +/- range of ln(K/F) the density is evaluated over


def call_curve(fit: SVIFit, n_grid: int = N_GRID) -> tuple[np.ndarray, np.ndarray]:
    """Strike grid and Black-76 call prices off the fitted smile."""
    k_grid = np.linspace(-LOG_MONEYNESS_RANGE, LOG_MONEYNESS_RANGE, n_grid)
    strikes = fit.forward * np.exp(k_grid)
    vols = fit.iv(k_grid)
    calls = np.array([black76_price(fit.forward, k, fit.time_to_expiry, v, "CE") for k, v in zip(strikes, vols)])
    return strikes, calls


def breeden_litzenberger_density(fit: SVIFit, n_grid: int = N_GRID) -> pd.DataFrame:
    """Risk-neutral density of S_T at ``fit``'s expiry, on a strike grid.

    Returns a DataFrame with columns strike, density, cdf (P(S_T <= strike)).
    """
    strikes, calls = call_curve(fit, n_grid)

    # The grid is uniform in log-moneyness, not in strike, so its spacing
    # widens away from the money — np.gradient handles that (it takes the
    # coordinate array), but any integral over it must use each segment's
    # actual width too, not a single constant step.
    density = np.gradient(np.gradient(calls, strikes), strikes)
    density = np.clip(density, 0.0, None)

    mass = np.trapezoid(density, strikes)
    if mass > 0:
        density = density / mass

    cdf = np.concatenate([[0.0], cumulative_trapezoid(density, strikes)])
    if cdf[-1] > 0:
        cdf = np.clip(cdf / cdf[-1], 0.0, 1.0)

    return pd.DataFrame({"strike": strikes, "density": density, "cdf": cdf})


def prob_above(density_df: pd.DataFrame, price: float) -> float:
    """P(S_T > price) by linear interpolation of the CDF."""
    cdf_at_price = float(np.interp(price, density_df["strike"], density_df["cdf"]))
    return 1.0 - cdf_at_price
