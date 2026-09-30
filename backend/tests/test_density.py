import numpy as np

from options_edge.density import breeden_litzenberger_density, prob_above
from options_edge.svi import SVIFit


def _flat_smile_fit(vol: float = 0.15, forward: float = 500.0, t: float = 0.25) -> SVIFit:
    """An SVI fit whose implied vol is (near) constant across strikes, so the
    risk-neutral density should come out close to lognormal — a case with a
    known, checkable shape."""
    w = vol * vol * t
    return SVIFit(expiry=None, forward=forward, time_to_expiry=t, a=w, b=0.0, rho=0.0, m=0.0, sigma=0.1,
                   n_points=10, rmse_iv=0.0)


def test_density_integrates_to_one():
    fit = _flat_smile_fit()
    d = breeden_litzenberger_density(fit)
    mass = np.trapezoid(d["density"], d["strike"])
    assert abs(mass - 1.0) < 1e-6


def test_density_nonnegative():
    fit = _flat_smile_fit()
    d = breeden_litzenberger_density(fit)
    assert (d["density"] >= 0).all()


def test_cdf_monotonic_and_bounded():
    fit = _flat_smile_fit()
    d = breeden_litzenberger_density(fit)
    assert (d["cdf"].diff().dropna() >= -1e-9).all()
    assert d["cdf"].iloc[0] == 0.0
    assert abs(d["cdf"].iloc[-1] - 1.0) < 1e-6


def test_prob_above_forward_near_half_for_flat_smile():
    # A flat (constant-vol) smile prices under lognormal-like dynamics, whose
    # median is below the mean/forward (positive skew of the log-normal),
    # so P(S_T > forward) should be a bit below, not wildly off, 0.5.
    fit = _flat_smile_fit()
    d = breeden_litzenberger_density(fit)
    p = prob_above(d, fit.forward)
    assert 0.3 < p < 0.5


def test_prob_above_decreases_with_price():
    fit = _flat_smile_fit()
    d = breeden_litzenberger_density(fit)
    p_low = prob_above(d, fit.forward * 0.9)
    p_mid = prob_above(d, fit.forward)
    p_high = prob_above(d, fit.forward * 1.1)
    assert p_low > p_mid > p_high


def test_wider_vol_spreads_the_density_out():
    narrow = breeden_litzenberger_density(_flat_smile_fit(vol=0.10))
    wide = breeden_litzenberger_density(_flat_smile_fit(vol=0.40))
    # A wider distribution assigns more probability far from the forward.
    threshold = 1.3 * 500.0
    assert prob_above(wide, threshold) > prob_above(narrow, threshold)
