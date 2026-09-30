import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from options_edge.pricing import black76_price
from options_edge.scheduler import is_due, recompute


class TestIsDue:
    def test_not_due_before_interval_elapses(self):
        assert not is_due(last_run=100.0, now=150.0, interval=60.0)

    def test_due_once_interval_elapses(self):
        assert is_due(last_run=100.0, now=160.0, interval=60.0)

    def test_first_run_is_always_due(self):
        assert is_due(last_run=float("-inf"), now=0.0, interval=300.0)


def build_chain(valuation_time, forward=565.0, discount=0.995, true_vol=0.20, t=30 / 365):
    """A tiny but realistic-shaped chain: enough strikes for a real SVI fit,
    both legs at every strike so put-call parity/forward estimation works."""
    strikes = [540, 550, 560, 565, 570, 580, 590]
    expiry = valuation_time + timedelta(days=round(t * 365))
    rows = []
    for strike in strikes:
        for option_type in ("CE", "PE"):
            mid = black76_price(forward, strike, t, true_vol, option_type, discount)
            half = max(mid * 0.02, 0.01)
            rows.append(
                {
                    "occ_symbol": f"TEST{strike}{option_type}",
                    "expiry": pd.Timestamp(expiry.date()),
                    "strike": float(strike),
                    "option_type": option_type,
                    "bid": mid - half,
                    "ask": mid + half,
                    "mid": mid,
                    "underlying": forward,
                    "quote_time": valuation_time,
                    "fetched_at": valuation_time,
                }
            )
    return pd.DataFrame(rows)


@pytest.fixture
def fetched_at():
    return datetime(2024, 1, 2, 15, 0, tzinfo=timezone.utc)


class TestRecompute:
    def test_writes_all_expected_files(self, tmp_path: Path, fetched_at):
        df = build_chain(fetched_at)
        recompute(df, "TEST", tmp_path, commission_per_contract=0.65, feed="indicative")

        for name in ("TEST_iv.parquet", "TEST_iv.json", "TEST_svi.parquet", "TEST_svi.json",
                     "TEST_arb.parquet", "TEST_arb.json", "TEST_arb_summary.json"):
            assert (tmp_path / name).exists(), f"missing {name}"

    def test_arb_summary_includes_commission_and_meta(self, tmp_path: Path, fetched_at):
        df = build_chain(fetched_at)
        recompute(df, "TEST", tmp_path, commission_per_contract=0.65, feed="indicative")

        summary = json.loads((tmp_path / "TEST_arb_summary.json").read_text())
        assert summary["commission_per_contract"] == 0.65
        assert summary["meta"]["symbol"] == "TEST"
        assert summary["meta"]["feed"] == "indicative"
        assert summary["meta"]["underlying"] == pytest.approx(565.0)
        assert "computed_at" in summary["meta"]

    def test_recompute_without_a_new_fetch_still_reflects_time_decay(self, tmp_path: Path, fetched_at):
        # Same raw quotes both times (as if no new fetch happened), but the
        # valuation time passed to the second recompute is 12 hours later.
        # time_to_expiry should shrink even though nothing else changed.
        df = build_chain(fetched_at)

        recompute(df, "TEST", tmp_path, commission_per_contract=0.0, feed="indicative", valuation_time=fetched_at)
        iv_first = pd.read_parquet(tmp_path / "TEST_iv.parquet")

        later = fetched_at + timedelta(hours=12)
        recompute(df, "TEST", tmp_path, commission_per_contract=0.0, feed="indicative", valuation_time=later)
        iv_second = pd.read_parquet(tmp_path / "TEST_iv.parquet")

        assert (iv_second["time_to_expiry"].to_numpy() < iv_first["time_to_expiry"].to_numpy()).all()
        # And that shift is (approximately) exactly 12 hours, in years.
        shift_years = (iv_first["time_to_expiry"] - iv_second["time_to_expiry"]).mean()
        assert shift_years == pytest.approx(12 / 24 / 365, rel=0.02)

    def test_recompute_returns_the_summary_it_wrote(self, tmp_path: Path, fetched_at):
        df = build_chain(fetched_at)
        summary = recompute(df, "TEST", tmp_path, commission_per_contract=0.0, feed="indicative")
        on_disk = json.loads((tmp_path / "TEST_arb_summary.json").read_text())
        assert summary["total"] == on_disk["total"]
