"""Fit raw SVI (Stochastic Volatility Inspired) to each expiry's mid-IV smile.

Raw SVI parameterizes total implied variance as a function of log-moneyness:

    w(k) = a + b * (rho * (k - m) + sqrt((k - m)^2 + sigma^2))

where ``k = ln(strike / forward)`` and ``w = iv^2 * T``. Five parameters
(a, b, rho, m, sigma) per expiry — fit by least squares against the mid IVs
from ``iv.py``'s surface (not bid/ask: those bracket the cost of trading the
smile, the mid is the best estimate of where it actually sits).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.optimize import least_squares

MIN_POINTS_TO_FIT = 5  # SVI has 5 free parameters


@dataclass
class SVIFit:
    expiry: pd.Timestamp
    forward: float
    time_to_expiry: float
    a: float
    b: float
    rho: float
    m: float
    sigma: float
    n_points: int
    rmse_iv: float

    def total_variance(self, k: np.ndarray) -> np.ndarray:
        k = np.asarray(k, dtype=float)
        return self.a + self.b * (
            self.rho * (k - self.m) + np.sqrt((k - self.m) ** 2 + self.sigma**2)
        )

    def iv(self, k: np.ndarray) -> np.ndarray:
        w = self.total_variance(k)
        return np.sqrt(np.maximum(w, 0.0) / self.time_to_expiry)


def _raw_svi(params: np.ndarray, k: np.ndarray) -> np.ndarray:
    a, b, rho, m, sigma = params
    return a + b * (rho * (k - m) + np.sqrt((k - m) ** 2 + sigma**2))


def _from_vertex(q: np.ndarray) -> np.ndarray:
    """(w_min, b, rho, m, sigma) -> raw (a, b, rho, m, sigma).

    SVI's minimum total variance is ``w_min = a + b*sigma*sqrt(1 - rho^2)``.
    The real constraint is ``w_min >= 0``; ``a`` itself may be negative (and is,
    for most real smiles). Fitting in ``w_min`` turns that constraint into a
    plain box bound.
    """
    w_min, b, rho, m, sigma = q
    return np.array([w_min - b * sigma * np.sqrt(1 - rho**2), b, rho, m, sigma])


def fit_svi_slice(k: np.ndarray, w: np.ndarray) -> tuple[np.ndarray, float]:
    """Least-squares fit of raw SVI to one expiry's (log-moneyness, total-variance)

    points. Returns ``(params, rmse_w)`` where ``params = [a, b, rho, m, sigma]``.

    SVI's least-squares surface has many local minima, so this runs from a
    small grid of starting points and keeps the best.
    """
    k = np.asarray(k, dtype=float)
    w = np.asarray(w, dtype=float)

    lo = np.array([0.0, 1e-6, -0.999, k.min() - 0.5, 1e-4])
    hi = np.array([max(float(np.max(w)), 1e-6), 10.0, 0.999, k.max() + 0.5, 2.0])

    best = None
    for rho0 in (-0.7, -0.3, 0.0, 0.3):
        for sigma0 in (0.01, 0.05, 0.2):
            for m0 in (float(k[np.argmin(w)]), 0.0):
                x0 = np.clip([float(np.min(w)), 0.1, rho0, m0, sigma0], lo, hi)
                result = least_squares(
                    lambda q: _raw_svi(_from_vertex(q), k) - w, x0, bounds=(lo, hi), max_nfev=4000
                )
                if best is None or result.cost < best.cost:
                    best = result

    rmse_w = float(np.sqrt(np.mean(best.fun**2)))
    return _from_vertex(best.x), rmse_w


def fit_svi_surface(iv_surface: pd.DataFrame, min_points: int = MIN_POINTS_TO_FIT) -> pd.DataFrame:
    """Fit one SVI slice per expiry to ``iv_surface``'s mid IVs.

    Expiries with fewer than ``min_points`` usable (non-NaN, forward-known)
    strikes are skipped — five parameters need more than five points to mean
    anything.
    """
    columns = [
        "expiry", "forward", "time_to_expiry", "a", "b", "rho", "m", "sigma",
        "n_points", "rmse_iv",
    ]
    if iv_surface.empty:
        return pd.DataFrame(columns=columns)

    rows = []
    for expiry, group in iv_surface.groupby("expiry"):
        usable = group.dropna(subset=["iv_mid", "forward"])
        usable = usable[usable["forward"] > 0]
        if len(usable) < min_points:
            continue

        forward = float(usable["forward"].iloc[0])
        t = float(usable["time_to_expiry"].iloc[0])
        k = np.log(usable["strike"].to_numpy() / forward)
        w = (usable["iv_mid"].to_numpy() ** 2) * t

        params, _ = fit_svi_slice(k, w)
        a, b, rho, m, sigma = params

        fit = SVIFit(
            expiry=expiry, forward=forward, time_to_expiry=t,
            a=a, b=b, rho=rho, m=m, sigma=sigma,
            n_points=len(usable), rmse_iv=0.0,
        )
        model_iv = fit.iv(k)
        rmse_iv = float(np.sqrt(np.mean((model_iv - usable["iv_mid"].to_numpy()) ** 2)))

        rows.append(
            {
                "expiry": expiry, "forward": forward, "time_to_expiry": t,
                "a": a, "b": b, "rho": rho, "m": m, "sigma": sigma,
                "n_points": len(usable), "rmse_iv": rmse_iv,
            }
        )

    return pd.DataFrame(rows, columns=columns).sort_values("expiry").reset_index(drop=True)
