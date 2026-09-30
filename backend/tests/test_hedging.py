import numpy as np
import pytest

from options_edge.hedging import (
    HedgeRule,
    default_rules,
    run_hedge_simulation,
    simulate_gbm_paths,
)

SPOT, STRIKE, VOL = 100.0, 100.0, 0.25
T = 5 / 365  # 5-day option keeps the test suite fast


class TestSimulateGbmPaths:
    def test_zero_vol_path_is_flat(self):
        paths = simulate_gbm_paths(SPOT, 0.0, T, n_steps=10, n_paths=5, seed=1)
        assert paths.shape == (5, 11)
        assert np.allclose(paths, SPOT)

    def test_terminal_price_is_a_martingale(self):
        # Risk-neutral GBM (r=0, q=0): E[S_T] = S0. Check within Monte Carlo error.
        paths = simulate_gbm_paths(SPOT, VOL, T, n_steps=50, n_paths=20_000, seed=2)
        terminal = paths[:, -1]
        se = terminal.std() / np.sqrt(len(terminal))
        assert terminal.mean() == pytest.approx(SPOT, abs=4 * se)

    def test_shape(self):
        assert simulate_gbm_paths(SPOT, VOL, T, n_steps=7, n_paths=13, seed=3).shape == (13, 8)


class TestHedgeRule:
    def test_requires_exactly_one_of_every_n_steps_or_band(self):
        with pytest.raises(ValueError):
            HedgeRule("bad")
        with pytest.raises(ValueError):
            HedgeRule("bad", every_n_steps=1, band=0.1)
        HedgeRule("ok1", every_n_steps=1)
        HedgeRule("ok2", band=0.1)


class TestRunHedgeSimulation:
    def _run(self, half_spread=0.005, n_paths=4000, seed=11, rules=None):
        rules = rules or [
            HedgeRule("Hourly", every_n_steps=1),
            HedgeRule("Every 4h", every_n_steps=4),
            HedgeRule("Daily", every_n_steps=24),
        ]
        return run_hedge_simulation(
            SPOT, STRIKE, T, VOL, "CE", half_spread, rules,
            contract_multiplier=100.0, step_hours=1.0, n_paths=n_paths, seed=seed,
        )

    def test_frictionless_mean_pnl_is_approximately_zero(self):
        # Fairly-priced option (premium = theoretical value), no transaction costs:
        # a writer who delta-hedges should break even in expectation.
        result = self._run(half_spread=0.0, n_paths=8000)
        for _, row in result.rules.iterrows():
            se = row["std_pnl"] / np.sqrt(8000)
            assert row["mean_pnl"] == pytest.approx(0.0, abs=5 * se)
            assert row["transaction_cost"] == 0.0

    def test_replication_error_falls_with_hedge_frequency(self):
        result = self._run(half_spread=0.0).rules.set_index("label")
        hourly = result.loc["Hourly", "replication_error"]
        four_h = result.loc["Every 4h", "replication_error"]
        daily = result.loc["Daily", "replication_error"]
        assert hourly < four_h < daily

    def test_transaction_cost_rises_with_hedge_frequency(self):
        result = self._run(half_spread=0.01).rules.set_index("label")
        hourly = result.loc["Hourly", "transaction_cost"]
        four_h = result.loc["Every 4h", "transaction_cost"]
        daily = result.loc["Daily", "transaction_cost"]
        assert hourly > four_h > daily

    def test_total_cost_is_sum_of_its_parts(self):
        result = self._run().rules
        assert np.allclose(result["total_cost"], result["transaction_cost"] + result["replication_error"])

    def test_band_zero_matches_hedging_every_step(self):
        rules = [HedgeRule("Every step", every_n_steps=1), HedgeRule("Band ~0", band=1e-9)]
        result = self._run(rules=rules, n_paths=4000).rules.set_index("label")
        # Same paths, same seed, essentially the same decisions -> essentially the same outcome.
        assert result.loc["Every step", "mean_trades"] == pytest.approx(result.loc["Band ~0", "mean_trades"], rel=0.02)
        assert result.loc["Every step", "replication_error"] == pytest.approx(
            result.loc["Band ~0", "replication_error"], rel=0.05
        )

    def test_wide_band_only_trades_at_open_and_close(self):
        rules = [HedgeRule("Never moves", band=1.0)]  # delta can't move by 1.0 in a single hourly step
        result = self._run(rules=rules).rules.iloc[0]
        assert result["mean_trades"] == pytest.approx(2.0, abs=0.01)

    def test_every_n_steps_larger_than_grid_raises(self):
        with pytest.raises(ValueError):
            self._run(rules=[HedgeRule("Too coarse", every_n_steps=10_000)])

    def test_premium_matches_black76_price(self):
        from options_edge.pricing import black76_price

        result = self._run()
        expected = black76_price(SPOT, STRIKE, T, VOL, "CE") * 100.0
        assert result.premium == pytest.approx(expected)


class TestDefaultRules:
    def test_excludes_intervals_coarser_or_finer_than_the_grid_allows(self):
        rules = default_rules(time_to_expiry=1 / 24 / 365, step_hours=0.5)  # n_steps = 2
        labels = {r.label for r in rules}
        assert "1 hour" in labels
        assert "2 hours" not in labels
        assert "Daily" not in labels

    def test_includes_band_rules_regardless_of_horizon(self):
        rules = default_rules(time_to_expiry=1 / 365)
        assert any(r.band is not None for r in rules)


class TestSide:
    def _run(self, side, half_spread=0.005, n_paths=4000, seed=11, rules=None):
        rules = rules or [
            HedgeRule("Hourly", every_n_steps=1),
            HedgeRule("Every 4h", every_n_steps=4),
            HedgeRule("Daily", every_n_steps=24),
        ]
        return run_hedge_simulation(
            SPOT, STRIKE, T, VOL, "CE", half_spread, rules, side=side,
            contract_multiplier=100.0, step_hours=1.0, n_paths=n_paths, seed=seed,
        )

    def test_rejects_invalid_side(self):
        with pytest.raises(ValueError):
            self._run(side="sideways")

    def test_frictionless_long_pnl_is_exact_negative_of_short_pnl_per_path(self):
        # Derivation: hedge target and every trade for "long" are the exact
        # negative of "short"'s at every step, so with no transaction costs the
        # cash flows -- and so total_pnl -- must be exact negatives, per path,
        # not just on average. The strongest correctness check available here.
        short = self._run("short", half_spread=0.0)
        long = self._run("long", half_spread=0.0)
        # mean_pnl/std_pnl are already per-rule aggregates of an exact per-path
        # negation, so they must match (mean negates, std is negation-invariant).
        for s_row, l_row in zip(short.rules.itertuples(), long.rules.itertuples()):
            assert l_row.mean_pnl == pytest.approx(-s_row.mean_pnl, abs=1e-6)
            assert l_row.std_pnl == pytest.approx(s_row.std_pnl, abs=1e-6)

    def test_transaction_cost_identical_regardless_of_side(self):
        # Same paths, same |delta| at every step -> same trade sizes -> same
        # slippage, whichever direction you're hedging.
        short = self._run("short", half_spread=0.01).rules.set_index("label")
        long = self._run("long", half_spread=0.01).rules.set_index("label")
        assert np.allclose(short["transaction_cost"], long["transaction_cost"])
        assert np.allclose(short["mean_trades"], long["mean_trades"])

    def test_long_frictionless_mean_pnl_is_approximately_zero(self):
        # A fairly-priced long option, delta-hedged, should also break even in
        # expectation once transaction costs are excluded -- same as short.
        result = self._run("long", half_spread=0.0, n_paths=8000)
        for row in result.rules.itertuples():
            se = row.std_pnl / np.sqrt(8000)
            assert row.mean_pnl == pytest.approx(0.0, abs=5 * se)

    def test_long_pays_premium_short_receives_it(self):
        short = self._run("short", rules=[HedgeRule("Daily", every_n_steps=24)])
        long = self._run("long", rules=[HedgeRule("Daily", every_n_steps=24)])
        assert short.premium == pytest.approx(long.premium)
        assert short.inputs["side"] == "short"
        assert long.inputs["side"] == "long"


class TestCommission:
    def _run(self, **overrides):
        rules = [HedgeRule("Hourly", every_n_steps=1), HedgeRule("Daily", every_n_steps=24)]
        kwargs = dict(
            spot=SPOT, strike=STRIKE, time_to_expiry=T, vol=VOL, option_type="CE",
            half_spread=0.005, rules=rules, contract_multiplier=100.0, step_hours=1.0,
            n_paths=2000, seed=11,
        )
        kwargs.update(overrides)
        return run_hedge_simulation(**kwargs)

    def test_zero_commission_matches_no_commission_kwargs(self):
        base = self._run().rules
        explicit = self._run(option_commission_per_contract=0.0, stock_commission_per_share=0.0).rules
        assert np.allclose(base["total_cost"], explicit["total_cost"])

    def test_option_commission_adds_a_flat_amount_to_every_rule(self):
        # A one-time fee paid regardless of hedge rule, so every rule's total
        # cost should shift by exactly the same amount.
        base = self._run().rules.set_index("label")
        with_fee = self._run(option_commission_per_contract=0.65).rules.set_index("label")
        for label in base.index:
            shift = with_fee.loc[label, "transaction_cost"] - base.loc[label, "transaction_cost"]
            assert shift == pytest.approx(0.65)
            # mean_pnl drops by exactly the fee too (paid once, deterministic).
            pnl_shift = base.loc[label, "mean_pnl"] - with_fee.loc[label, "mean_pnl"]
            assert pnl_shift == pytest.approx(0.65)

    def test_option_commission_scales_with_contract_multiplier(self):
        # Isolate the commission component by diffing against a zero-commission
        # run at the same contract_multiplier, for 1 contract and for 3.
        one = self._run(option_commission_per_contract=0.65, contract_multiplier=100.0).rules
        one_base = self._run(contract_multiplier=100.0).rules
        three = self._run(option_commission_per_contract=0.65, contract_multiplier=300.0).rules
        three_base = self._run(contract_multiplier=300.0).rules

        fee_at_one_contract = (one["transaction_cost"] - one_base["transaction_cost"]).mean()
        fee_at_three_contracts = (three["transaction_cost"] - three_base["transaction_cost"]).mean()
        assert fee_at_one_contract == pytest.approx(0.65)
        assert fee_at_three_contracts == pytest.approx(0.65 * 3)

    def test_stock_commission_raises_transaction_cost_more_for_frequent_hedging(self):
        base = self._run().rules.set_index("label")
        with_fee = self._run(stock_commission_per_share=0.005).rules.set_index("label")
        hourly_shift = with_fee.loc["Hourly", "transaction_cost"] - base.loc["Hourly", "transaction_cost"]
        daily_shift = with_fee.loc["Daily", "transaction_cost"] - base.loc["Daily", "transaction_cost"]
        # Hourly trades far more shares over the option's life than Daily, so
        # the same per-share fee adds much more to Hourly's total.
        assert hourly_shift > daily_shift > 0

    def test_commissions_recorded_in_inputs(self):
        result = self._run(option_commission_per_contract=0.65, stock_commission_per_share=0.01)
        assert result.inputs["option_commission_per_contract"] == 0.65
        assert result.inputs["stock_commission_per_share"] == 0.01
