import math

import pytest

from options_edge.pricing import black76_price, implied_vol


@pytest.mark.parametrize("option_type", ["CE", "PE"])
@pytest.mark.parametrize("true_vol", [0.10, 0.25, 0.60, 1.20])
def test_implied_vol_round_trip(option_type, true_vol):
    forward, strike, t, discount = 100.0, 105.0, 0.25, 0.98
    price = black76_price(forward, strike, t, true_vol, option_type, discount)
    recovered = implied_vol(price, forward, strike, t, option_type, discount)
    assert recovered == pytest.approx(true_vol, abs=1e-4)


def test_implied_vol_deep_itm_price_returns_nan():
    # Price below intrinsic value (crossed/stale quote) has no valid vol.
    forward, strike, t, discount = 100.0, 50.0, 0.25, 1.0
    bogus_price = discount * (forward - strike) - 10  # below intrinsic
    result = implied_vol(bogus_price, forward, strike, t, "CE", discount)
    assert math.isnan(result)


def test_implied_vol_zero_time_to_expiry_returns_nan():
    result = implied_vol(5.0, 100.0, 105.0, 0.0, "CE")
    assert math.isnan(result)


def test_black76_price_at_zero_vol_is_intrinsic():
    assert black76_price(100.0, 90.0, 0.25, 0.0, "CE") == pytest.approx(10.0)
    assert black76_price(100.0, 110.0, 0.25, 0.0, "CE") == pytest.approx(0.0)
    assert black76_price(100.0, 110.0, 0.25, 0.0, "PE") == pytest.approx(10.0)


from options_edge.pricing import black76_delta


class TestDelta:
    @pytest.mark.parametrize("vol", [0.10, 0.25, 0.60])
    @pytest.mark.parametrize("strike", [80.0, 100.0, 120.0])
    def test_delta_matches_numerical_derivative_of_price(self, strike, vol):
        f, t, d, h = 100.0, 0.3, 0.97, 0.01
        for option_type in ("CE", "PE"):
            analytic = black76_delta(f, strike, t, vol, option_type, d)
            numeric = (
                black76_price(f + h, strike, t, vol, option_type, d)
                - black76_price(f - h, strike, t, vol, option_type, d)
            ) / (2 * h)
            assert analytic == pytest.approx(numeric, abs=1e-4)

    def test_call_delta_in_0_D_put_delta_in_negD_0(self):
        for strike in (60.0, 100.0, 140.0):
            call = black76_delta(100.0, strike, 0.3, 0.25, "CE", 0.97)
            put = black76_delta(100.0, strike, 0.3, 0.25, "PE", 0.97)
            assert 0.0 <= call <= 0.97
            assert -0.97 <= put <= 0.0

    def test_put_call_delta_parity(self):
        # dC/dF - dP/dF = D (from C - P = D(F - K))
        call = black76_delta(100.0, 105.0, 0.3, 0.3, "CE", 0.97)
        put = black76_delta(100.0, 105.0, 0.3, 0.3, "PE", 0.97)
        assert call - put == pytest.approx(0.97, abs=1e-9)

    def test_atm_delta_near_half_of_discount(self):
        call = black76_delta(100.0, 100.0, 0.3, 0.25, "CE", 1.0)
        assert call == pytest.approx(0.5, abs=0.05)

    def test_zero_vol_delta_is_step_function(self):
        assert black76_delta(110.0, 100.0, 0.3, 0.0, "CE", 1.0) == 1.0
        assert black76_delta(90.0, 100.0, 0.3, 0.0, "CE", 1.0) == 0.0
        assert black76_delta(90.0, 100.0, 0.3, 0.0, "PE", 1.0) == -1.0

    def test_zero_time_delta_is_step_function(self):
        assert black76_delta(110.0, 100.0, 0.0, 0.25, "CE", 1.0) == 1.0
        assert black76_delta(90.0, 100.0, 0.0, 0.25, "CE", 1.0) == 0.0
