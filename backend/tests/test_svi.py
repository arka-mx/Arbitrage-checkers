import numpy as np
import pandas as pd
import pytest

from options_edge.svi import _raw_svi, fit_svi_slice, fit_svi_surface

TRUE_PARAMS = {"a": 0.02, "b": 0.15, "rho": -0.4, "m": 0.02, "sigma": 0.12}


def true_w(k):
    return _raw_svi(np.array(list(TRUE_PARAMS.values())), np.asarray(k))


def test_fit_svi_slice_recovers_exact_curve():
    k = np.linspace(-0.3, 0.3, 15)
    w = true_w(k)

    params, rmse_w = fit_svi_slice(k, w)
    fitted_w = _raw_svi(params, k)

    assert rmse_w == pytest.approx(0.0, abs=1e-8)
    assert np.allclose(fitted_w, w, atol=1e-6)


def test_fit_svi_slice_stays_close_with_noise():
    rng = np.random.default_rng(0)
    k = np.linspace(-0.3, 0.3, 25)
    w = true_w(k) + rng.normal(0, 0.0005, size=k.size)

    params, rmse_w = fit_svi_slice(k, w)
    assert rmse_w < 0.002


def build_iv_surface(expiry, forward, t, strikes):
    k = np.log(np.asarray(strikes) / forward)
    w = true_w(k)
    iv_mid = np.sqrt(w / t)
    return pd.DataFrame(
        {
            "expiry": [expiry] * len(strikes),
            "strike": strikes,
            "option_type": ["CE" if s >= forward else "PE" for s in strikes],
            "forward": forward,
            "discount_factor": 1.0,
            "time_to_expiry": t,
            "bid": iv_mid,  # not used by the fit
            "ask": iv_mid,
            "mid": iv_mid,
            "iv_bid": iv_mid,
            "iv_mid": iv_mid,
            "iv_ask": iv_mid,
        }
    )


def test_fit_svi_surface_one_row_per_expiry():
    expiry1 = pd.Timestamp("2024-10-04")
    expiry2 = pd.Timestamp("2024-10-11")
    strikes = [540, 550, 560, 565, 570, 580, 590]
    df = pd.concat(
        [
            build_iv_surface(expiry1, 565.0, 7 / 365, strikes),
            build_iv_surface(expiry2, 565.0, 14 / 365, strikes),
        ],
        ignore_index=True,
    )

    surface = fit_svi_surface(df)
    assert len(surface) == 2
    assert set(surface["expiry"]) == {expiry1, expiry2}
    assert (surface["rmse_iv"] < 1e-3).all()


def test_fit_svi_surface_recovers_known_params():
    expiry = pd.Timestamp("2024-10-04")
    strikes = np.linspace(500, 630, 20)
    df = build_iv_surface(expiry, 565.0, 30 / 365, strikes)

    surface = fit_svi_surface(df)
    row = surface.iloc[0]
    for name, true_value in TRUE_PARAMS.items():
        # Loose-ish tolerance: iv_mid = sqrt(w/T) then w = iv_mid^2*T round-trips
        # through a sqrt/square, so the fit sees slightly perturbed targets.
        assert row[name] == pytest.approx(true_value, abs=5e-3)


def test_fit_svi_surface_skips_expiry_with_too_few_points():
    expiry = pd.Timestamp("2024-10-04")
    df = build_iv_surface(expiry, 565.0, 7 / 365, [560, 565, 570])  # only 3 points
    surface = fit_svi_surface(df)
    assert surface.empty


def test_fit_svi_surface_empty_input_returns_empty():
    result = fit_svi_surface(pd.DataFrame())
    assert result.empty
    assert list(result.columns) == [
        "expiry", "forward", "time_to_expiry", "a", "b", "rho", "m", "sigma",
        "n_points", "rmse_iv",
    ]


def test_fit_svi_slice_handles_negative_a():
    # Real smiles usually need a < 0 (only the vertex variance a + b*sigma*sqrt(1-rho^2)
    # must be >= 0). The old a >= 0 bound pinned a at 0 and missed curvature like this.
    true = np.array([-0.01, 0.2, -0.3, 0.0, 0.1])  # vertex variance ~0.0091 > 0
    k = np.linspace(-0.2, 0.2, 21)
    w = _raw_svi(true, k)

    params, rmse_w = fit_svi_slice(k, w)
    assert params[0] < 0
    assert rmse_w < 1e-6
    assert np.allclose(_raw_svi(params, k), w, atol=1e-6)


def test_fit_svi_slice_never_returns_negative_variance():
    rng = np.random.default_rng(1)
    k = np.linspace(-0.25, 0.25, 30)
    w = np.maximum(true_w(k) + rng.normal(0, 0.003, k.size), 1e-5)  # noisy, near zero
    a, b, rho, m, sigma = fit_svi_slice(k, w)[0]
    assert a + b * sigma * np.sqrt(1 - rho**2) >= -1e-12
