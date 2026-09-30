import math

import numpy as np
import pytest

from options_edge.forward import estimate_forward
from options_edge.pricing import black76_price


def test_estimate_forward_recovers_known_forward_and_discount():
    true_forward, true_discount = 565.0, 0.995
    strikes = np.array([540.0, 550.0, 560.0, 570.0, 580.0])
    # Build exact synthetic call/put mids consistent with parity at these strikes.
    calls = true_discount * np.maximum(true_forward - strikes, 0.0) + 1.5  # + arbitrary time value
    puts = calls - true_discount * (true_forward - strikes)

    forward, discount = estimate_forward(strikes, calls, puts)
    assert forward == pytest.approx(true_forward, abs=1e-6)
    assert discount == pytest.approx(true_discount, abs=1e-6)


def test_estimate_forward_needs_at_least_two_strikes():
    forward, discount = estimate_forward([100.0], [5.0], [4.0])
    assert math.isnan(forward)
    assert math.isnan(discount)


def test_estimate_forward_handles_degenerate_zero_spread_strikes():
    forward, discount = estimate_forward([100.0, 100.0], [5.0, 5.1], [4.0, 4.1])
    assert math.isnan(forward)
    assert math.isnan(discount)
