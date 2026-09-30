"""Client for Alpaca's options market data: contract metadata + live quotes.

Two Alpaca endpoints are combined because neither alone has everything a
clean quote row needs:
  - ``TradingClient.get_option_contracts`` returns structured strike/expiry/
    type/open-interest per contract, but no live bid/ask.
  - ``OptionHistoricalDataClient.get_option_chain`` returns live bid/ask/mid
    per contract, but only keyed by OCC symbol (no strike/expiry fields).
Joining the two on the OCC symbol gives one row per contract with both.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date

from alpaca.data.enums import OptionsFeed
from alpaca.data.historical.option import OptionHistoricalDataClient
from alpaca.data.models.snapshots import OptionsSnapshot
from alpaca.data.requests import OptionChainRequest
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import AssetStatus
from alpaca.trading.models import OptionContract
from alpaca.trading.requests import GetOptionContractsRequest


def _credentials() -> tuple[str, str]:
    api_key = os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY_ID")
    secret_key = os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_API_SECRET_KEY")
    if not api_key or not secret_key:
        raise RuntimeError(
            "Alpaca credentials not found. Set APCA_API_KEY_ID and "
            "APCA_API_SECRET_KEY (a backend/.env file is picked up automatically)."
        )
    return api_key, secret_key


@dataclass
class RawChain:
    contracts: list[OptionContract] = field(default_factory=list)
    quotes: dict[str, OptionsSnapshot] = field(default_factory=dict)


class AlpacaOptionsClient:
    """Fetches contract metadata + a live quote snapshot for one underlying."""

    def __init__(self):
        api_key, secret_key = _credentials()
        self.trading_client = TradingClient(api_key, secret_key, paper=True)
        self.data_client = OptionHistoricalDataClient(api_key, secret_key)

    def fetch_chain(
        self,
        underlying_symbol: str,
        expiration_date_gte: date | None = None,
        expiration_date_lte: date | None = None,
        feed: OptionsFeed = OptionsFeed.INDICATIVE,
    ) -> RawChain:
        """``feed``: OPRA is the real consolidated tape (needs the OPRA agreement
        signed in the Alpaca dashboard). INDICATIVE is Alpaca's derived free feed —
        fine for plumbing, but not the real NBBO, so no arbitrage found on it is
        evidence of a tradeable one."""
        contracts: list[OptionContract] = []
        page_token = None
        while True:
            request = GetOptionContractsRequest(
                underlying_symbols=[underlying_symbol],
                expiration_date_gte=expiration_date_gte,
                expiration_date_lte=expiration_date_lte,
                status=AssetStatus.ACTIVE,
                page_token=page_token,
            )
            response = self.trading_client.get_option_contracts(request)
            contracts.extend(response.option_contracts)
            page_token = response.next_page_token
            if not page_token:
                break

        quotes = self.data_client.get_option_chain(
            OptionChainRequest(
                underlying_symbol=underlying_symbol,
                expiration_date_gte=expiration_date_gte,
                expiration_date_lte=expiration_date_lte,
                feed=feed,
            )
        )
        return RawChain(contracts=contracts, quotes=quotes)
