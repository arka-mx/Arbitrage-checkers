from datetime import date, datetime, timezone
from types import SimpleNamespace

import pandas as pd
import pytest

from options_edge.alpaca_client import RawChain
from options_edge.loader import clean, raw_to_frame


def make_contract(symbol, root_symbol, expiry, strike, option_type, open_interest):
    return SimpleNamespace(
        symbol=symbol,
        root_symbol=root_symbol,
        expiration_date=expiry,
        strike_price=strike,
        type=SimpleNamespace(value=option_type),
        open_interest=open_interest,
    )


QUOTE_TIME = datetime(2024, 9, 26, 15, 30, tzinfo=timezone.utc)


def make_snapshot(bid, ask, bid_size, ask_size, last_trade_price, iv):
    quote = None
    if bid is not None or ask is not None:
        quote = SimpleNamespace(
            bid_price=bid, ask_price=ask, bid_size=bid_size, ask_size=ask_size, timestamp=QUOTE_TIME
        )
    trade = SimpleNamespace(price=last_trade_price) if last_trade_price is not None else None
    return SimpleNamespace(latest_quote=quote, latest_trade=trade, implied_volatility=iv)


@pytest.fixture
def raw_chain():
    expiry = date(2024, 9, 26)
    contracts = [
        make_contract("SPY240926C00560000", "SPY", expiry, 560.0, "call", 1200),
        make_contract("SPY240926P00560000", "SPY", expiry, 560.0, "put", 900),
        # zero bid -> should be dropped by clean()
        make_contract("SPY240926C00570000", "SPY", expiry, 570.0, "call", 2000),
        # no quote at all (not in the snapshots dict) -> should be dropped
        make_contract("SPY240926C00580000", "SPY", expiry, 580.0, "call", 50),
    ]
    quotes = {
        "SPY240926C00560000": make_snapshot(4.90, 5.10, 10, 12, 5.00, 0.132),
        "SPY240926P00560000": make_snapshot(3.95, 4.08, 20, 20, 4.00, 0.141),
        "SPY240926C00570000": make_snapshot(0.0, 1.50, 0, 5, 1.20, 0.129),
    }
    return RawChain(contracts=contracts, quotes=quotes)


def test_raw_to_frame_shape(raw_chain):
    df = raw_to_frame(raw_chain, underlying_price=565.25)
    assert len(df) == 4
    assert set(df["option_type"]) == {"CE", "PE"}
    assert (df["underlying"] == 565.25).all()


def test_raw_to_frame_columns(raw_chain):
    df = raw_to_frame(raw_chain, underlying_price=565.25)
    expected = {
        "occ_symbol", "root_symbol", "expiry", "strike", "option_type",
        "bid", "ask", "bid_size", "ask_size", "quote_time", "ltp", "oi", "alpaca_iv",
        "underlying", "fetched_at",
    }
    assert expected.issubset(df.columns)


def test_quote_time_parsed_as_utc_and_missing_for_unquoted(raw_chain):
    df = raw_to_frame(raw_chain, underlying_price=565.25).set_index("occ_symbol")
    assert df.loc["SPY240926C00560000", "quote_time"] == pd.Timestamp(QUOTE_TIME)
    assert pd.isna(df.loc["SPY240926C00580000", "quote_time"])


def test_missing_quote_becomes_nan_bid_ask(raw_chain):
    df = raw_to_frame(raw_chain, underlying_price=565.25)
    row = df[df["occ_symbol"] == "SPY240926C00580000"].iloc[0]
    assert pd.isna(row["bid"])
    assert pd.isna(row["ask"])


def test_clean_drops_zero_bid_and_missing_quotes(raw_chain):
    df = raw_to_frame(raw_chain, underlying_price=565.25)
    cleaned = clean(df)
    assert len(cleaned) == 2
    assert set(cleaned["occ_symbol"]) == {"SPY240926C00560000", "SPY240926P00560000"}


def test_clean_computes_mid_and_spread(raw_chain):
    df = raw_to_frame(raw_chain, underlying_price=565.25)
    cleaned = clean(df)
    row = cleaned[cleaned["occ_symbol"] == "SPY240926C00560000"].iloc[0]
    assert row["mid"] == pytest.approx((4.90 + 5.10) / 2)
    assert row["spread"] == pytest.approx(5.10 - 4.90)
    assert row["spread_pct"] == pytest.approx(row["spread"] / row["mid"])


def test_clean_max_spread_pct_filters_wide_quotes(raw_chain):
    df = raw_to_frame(raw_chain, underlying_price=565.25)
    # call: spread_pct = 0.20/5.00 = 4%, put: spread_pct = 0.13/4.015 ~= 3.2%
    cleaned = clean(df, max_spread_pct=0.035)
    assert set(cleaned["occ_symbol"]) == {"SPY240926P00560000"}


def test_clean_empty_frame_returns_empty():
    empty = pd.DataFrame(columns=["bid", "ask"])
    result = clean(empty)
    assert result.empty


def test_feed_is_recorded_on_every_row_and_survives_clean(raw_chain):
    df = clean(raw_to_frame(raw_chain, underlying_price=565.25, feed="indicative"))
    assert not df.empty
    assert (df["feed"] == "indicative").all()
