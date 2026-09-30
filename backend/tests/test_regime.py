import numpy as np
import pandas as pd

from options_edge.regime import REALIZED_VOL_WINDOW, TRADING_DAYS_PER_YEAR, realized_vol


def test_realized_vol_recovers_known_constant_vol():
    # Build a synthetic price path with an exact daily log-return std, and
    # check the rolling annualized estimate recovers it.
    rng = np.random.default_rng(0)
    daily_vol = 0.02
    n = 300
    log_returns = rng.normal(loc=0.0, scale=daily_vol, size=n)
    closes = pd.Series(100 * np.exp(np.cumsum(log_returns)))

    vol = realized_vol(closes, window=60).dropna()
    expected_annualized = daily_vol * np.sqrt(TRADING_DAYS_PER_YEAR)
    # A single 60-day sample window has real sampling noise; check the
    # average estimate over many windows lands within ~15% of the true value.
    assert abs(vol.mean() - expected_annualized) / expected_annualized < 0.15


def test_realized_vol_is_nan_before_window_fills():
    # A window of N needs N+1 prices (N returns) for one full estimate.
    closes = pd.Series(np.linspace(100, 110, REALIZED_VOL_WINDOW + 1))
    vol = realized_vol(closes, window=REALIZED_VOL_WINDOW)
    assert vol.iloc[:-1].isna().all()
    assert not pd.isna(vol.iloc[-1])


def test_realized_vol_higher_for_choppier_series():
    rng = np.random.default_rng(1)
    n = 200
    calm = pd.Series(100 * np.exp(np.cumsum(rng.normal(0, 0.005, n))))
    choppy = pd.Series(100 * np.exp(np.cumsum(rng.normal(0, 0.03, n))))
    assert realized_vol(choppy).dropna().mean() > realized_vol(calm).dropna().mean()
