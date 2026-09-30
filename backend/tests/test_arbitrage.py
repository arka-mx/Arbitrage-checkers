from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from options_edge.arbitrage import butterfly_violations, calendar_violations

EXPIRY = pd.Timestamp("2024-10-04")
T0 = datetime(2024, 10, 1, 15, 0, tzinfo=timezone.utc)


def quotes(strikes, mids, half_spread=0.1, option_type="CE", expiry=EXPIRY, times=None):
    mids = np.asarray(mids, dtype=float)
    return pd.DataFrame(
        {
            "expiry": expiry,
            "strike": np.asarray(strikes, dtype=float),
            "option_type": option_type,
            "bid": mids - half_spread,
            "ask": mids + half_spread,
            "mid": mids,
            "quote_time": pd.to_datetime(times if times is not None else [T0] * len(mids), utc=True),
        }
    )


class TestButterfly:
    def test_convex_prices_have_no_violations(self):
        df = quotes([100, 105, 110, 115], [12.0, 8.0, 5.0, 3.0])
        violations, n_checked = butterfly_violations(df)
        assert violations.empty
        assert n_checked == 2  # two adjacent triples

    def test_overpriced_body_is_a_violation_that_survives_a_tight_spread(self):
        # 0.5*10 - 6 + 0.5*1 = -0.5 at mid; crossed: 0.5*10.1 - 5.9 + 0.5*1.1 = -0.3
        df = quotes([100, 105, 110], [10.0, 6.0, 1.0], half_spread=0.1)
        violations, _ = butterfly_violations(df)
        row = violations.iloc[0]
        assert row["mid_value"] == pytest.approx(-0.5)
        assert row["exec_value"] == pytest.approx(-0.3)
        assert row["survives"]
        assert (row["k1"], row["k2"], row["k3"]) == (100, 105, 110)

    def test_small_violation_is_eaten_by_the_spread(self):
        # mid: 5.0 - 5.55 + 0.5 = -0.05; crossed: 5.05 - 5.45 + 0.55 = +0.15
        df = quotes([100, 105, 110], [10.0, 5.55, 1.0], half_spread=0.1)
        violations, _ = butterfly_violations(df)
        assert len(violations) == 1
        assert violations.iloc[0]["mid_value"] == pytest.approx(-0.05)
        assert violations.iloc[0]["exec_value"] == pytest.approx(0.15)
        assert not violations.iloc[0]["survives"]

    def test_unequal_strike_spacing_uses_correct_weights(self):
        # Prices linear in strike (P = 0.4K - 36) sit exactly on the convexity
        # boundary. Equal 1/2 weights give 2 - 8 + 5 = -1 (a false flag);
        # lam = 1/3 gives 4/3 - 8 + 20/3 = 0.
        df = quotes([100, 110, 115], [4.0, 8.0, 10.0], option_type="PE")
        violations, _ = butterfly_violations(df)
        assert violations.empty

    def test_calls_and_puts_are_checked_separately(self):
        calls = quotes([100, 105, 110], [10.0, 6.0, 1.0], option_type="CE")
        puts = quotes([100, 105, 110], [1.0, 3.0, 6.0], option_type="PE")  # convex
        violations, n_checked = butterfly_violations(pd.concat([calls, puts]))
        assert n_checked == 2
        assert list(violations["option_type"]) == ["CE"]

    def test_reports_quote_time_skew_across_legs(self):
        times = [T0, T0 + timedelta(seconds=30), T0 + timedelta(seconds=5)]
        df = quotes([100, 105, 110], [10.0, 6.0, 1.0], times=times)
        violations, _ = butterfly_violations(df)
        assert violations.iloc[0]["leg_time_skew_s"] == pytest.approx(30.0)

    def test_too_few_strikes_checks_nothing(self):
        violations, n_checked = butterfly_violations(quotes([100, 105], [5.0, 3.0]))
        assert violations.empty
        assert n_checked == 0


def term(mids, strike=100.0, half_spread=0.1, option_type="CE"):
    expiries = [EXPIRY + pd.Timedelta(days=7 * i) for i in range(len(mids))]
    return pd.concat(
        [quotes([strike], [m], half_spread, option_type, expiry=e) for m, e in zip(mids, expiries)],
        ignore_index=True,
    )


class TestCalendar:
    def test_increasing_in_maturity_has_no_violations(self):
        violations, n_checked = calendar_violations(term([2.0, 3.0, 3.5]))
        assert violations.empty
        assert n_checked == 3  # all pairs of 3 expiries

    def test_cheaper_far_option_is_a_violation(self):
        # far - near at mid: 2.5 - 3.0 = -0.5; crossed: 2.6 - 2.9 = -0.3
        violations, _ = calendar_violations(term([3.0, 2.5]))
        row = violations.iloc[0]
        assert row["mid_value"] == pytest.approx(-0.5)
        assert row["exec_value"] == pytest.approx(-0.3)
        assert row["survives"]
        assert row["expiry"] < row["expiry_far"]

    def test_small_violation_is_eaten_by_the_spread(self):
        # mid: 2.95 - 3.0 = -0.05; crossed: 3.05 - 2.9 = +0.15
        violations, _ = calendar_violations(term([3.0, 2.95]))
        assert len(violations) == 1
        assert not violations.iloc[0]["survives"]

    def test_non_adjacent_pair_can_survive_when_adjacent_pairs_do_not(self):
        # mids 3.00 / 2.85 / 2.70, half-spread 0.10. Crossed (far ask - near bid):
        #   T1->T2: 2.95 - 2.90 = +0.05  (eaten by costs)
        #   T2->T3: 2.80 - 2.75 = +0.05  (eaten by costs)
        #   T1->T3: 2.80 - 2.90 = -0.10  (survives) -- why all pairs are checked
        violations, _ = calendar_violations(term([3.0, 2.85, 2.70]))
        survivors = violations[violations["survives"]]
        assert len(violations) == 3
        assert len(survivors) == 1
        assert survivors.iloc[0]["expiry"] == EXPIRY
        assert survivors.iloc[0]["expiry_far"] == EXPIRY + pd.Timedelta(days=14)
        assert survivors.iloc[0]["exec_value"] == pytest.approx(-0.10)

    def test_different_strikes_and_types_are_not_compared(self):
        df = pd.concat([
            term([3.0], strike=100.0),
            term([1.0], strike=105.0).assign(expiry=EXPIRY + pd.Timedelta(days=7)),
            term([0.5], option_type="PE").assign(expiry=EXPIRY + pd.Timedelta(days=7)),
        ])
        violations, n_checked = calendar_violations(df)
        assert violations.empty
        assert n_checked == 0


def test_check_arbitrage_combines_both_kinds_into_summary():
    from options_edge.arbitrage import check_arbitrage

    fly = quotes([100, 105, 110], [10.0, 6.0, 1.0])  # 1 surviving butterfly
    # 1 calendar, eaten by costs. Puts, so it can't join the call butterfly group.
    cal = term([3.0, 2.95], strike=200.0, option_type="PE")
    violations, summary = check_arbitrage(pd.concat([fly, cal], ignore_index=True))

    assert summary["butterfly"] == {"checked": 1, "violations": 1, "survive": 1}
    assert summary["calendar"] == {"checked": 1, "violations": 1, "survive": 0}
    assert summary["total"] == {"checked": 2, "violations": 2, "survive": 1}
    assert set(violations["kind"]) == {"butterfly", "calendar"}


def test_check_arbitrage_clean_surface():
    from options_edge.arbitrage import check_arbitrage

    violations, summary = check_arbitrage(quotes([100, 105, 110], [12.0, 8.0, 5.0]))
    assert violations.empty
    assert summary["total"] == {"checked": 1, "violations": 0, "survive": 0}


class TestCommission:
    def test_butterfly_commission_is_two_contracts_worth(self):
        # mid: 0.5*10 - 6 + 0.5*1 = -0.5; crossed only: -0.3 (see earlier test).
        # +2*0.10 commission -> -0.3 + 0.20 = -0.10: still negative, survives.
        df = quotes([100, 105, 110], [10.0, 6.0, 1.0], half_spread=0.1)
        violations, _ = butterfly_violations(df, commission_per_contract=0.10)
        row = violations.iloc[0]
        assert row["commission"] == pytest.approx(0.20)
        assert row["exec_value"] == pytest.approx(-0.10)
        assert row["survives"]

    def test_butterfly_commission_can_flip_a_survivor_to_eaten(self):
        # Same setup, but 0.20/contract commission -> -0.3 + 0.40 = +0.10: no longer survives.
        df = quotes([100, 105, 110], [10.0, 6.0, 1.0], half_spread=0.1)
        violations, _ = butterfly_violations(df, commission_per_contract=0.20)
        row = violations.iloc[0]
        assert row["exec_value"] == pytest.approx(0.10)
        assert not row["survives"]

    def test_calendar_commission_is_two_contracts_worth(self):
        # mid: 2.5-3.0=-0.5; crossed only: 2.6-2.9=-0.3 (see earlier test).
        # +2*0.10 -> -0.3+0.20 = -0.10: still survives.
        df = term([3.0, 2.5])
        violations, _ = calendar_violations(df, commission_per_contract=0.10)
        row = violations.iloc[0]
        assert row["commission"] == pytest.approx(0.20)
        assert row["exec_value"] == pytest.approx(-0.10)
        assert row["survives"]

    def test_zero_commission_matches_no_commission_argument(self):
        df = quotes([100, 105, 110], [10.0, 6.0, 1.0], half_spread=0.1)
        with_default = butterfly_violations(df)[0]
        with_zero = butterfly_violations(df, commission_per_contract=0.0)[0]
        assert with_default["exec_value"].equals(with_zero["exec_value"])

    def test_check_arbitrage_reports_commission_in_summary(self):
        from options_edge.arbitrage import check_arbitrage

        df = quotes([100, 105, 110], [10.0, 6.0, 1.0], half_spread=0.1)
        _, summary = check_arbitrage(df, commission_per_contract=0.25)
        assert summary["commission_per_contract"] == 0.25
