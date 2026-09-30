"""CLI: run the delta-hedging simulator and print its result as JSON.

Pure computation — takes option parameters the caller already has (spot,
strike, vol, time to expiry), no Alpaca credentials or network needed. This
is what the frontend's /api/hedge route shells out to for an on-demand
"sell this option" simulation.

    python -m options_edge.hedge_cli --spot 765 --strike 770 --option-type CE \
        --time-to-expiry 0.0822 --vol 0.157 --half-spread 0.05
"""

from __future__ import annotations

import argparse
import json
import math
import sys

from .arbitrage import DEFAULT_COMMISSION_PER_CONTRACT
from .hedging import default_rules, run_hedge_simulation


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spot", type=float, required=True)
    parser.add_argument("--strike", type=float, required=True)
    parser.add_argument("--option-type", choices=["CE", "PE"], required=True)
    parser.add_argument("--time-to-expiry", type=float, required=True, help="Years to expiry.")
    parser.add_argument("--vol", type=float, required=True, help="Annualized vol used for both simulation and hedging.")
    parser.add_argument(
        "--side", choices=["short", "long"], default="short",
        help="short = you wrote/sold the option (received the premium); long = you bought it (paid the premium).",
    )
    parser.add_argument("--half-spread", type=float, default=0.05, help="Half the underlying's bid-ask spread, $/share.")
    parser.add_argument(
        "--option-commission-per-contract",
        type=float,
        default=DEFAULT_COMMISSION_PER_CONTRACT,
        help=f"Broker fee to open the option position, paid once, per contract "
        f"(default ${DEFAULT_COMMISSION_PER_CONTRACT:.2f}, illustrative). Pass 0 to exclude it.",
    )
    parser.add_argument(
        "--stock-commission-per-share",
        type=float,
        default=0.0,
        help="Broker fee per share on every hedge rebalance trade, on top of half-spread "
        "(default $0 — most brokers, Alpaca included, don't charge one for stock trades).",
    )
    parser.add_argument("--contract-multiplier", type=float, default=100.0)
    parser.add_argument("--step-hours", type=float, default=0.5)
    parser.add_argument("--n-paths", type=int, default=1200)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    if args.time_to_expiry <= 0:
        print(json.dumps({"error": "Option has already expired (time_to_expiry <= 0)."}))
        sys.exit(1)
    if args.vol <= 0 or not math.isfinite(args.vol):
        print(json.dumps({"error": f"Invalid vol: {args.vol}."}))
        sys.exit(1)

    rules = default_rules(args.time_to_expiry, step_hours=args.step_hours)
    result = run_hedge_simulation(
        spot=args.spot,
        strike=args.strike,
        time_to_expiry=args.time_to_expiry,
        vol=args.vol,
        option_type=args.option_type,
        half_spread=args.half_spread,
        rules=rules,
        side=args.side,
        option_commission_per_contract=args.option_commission_per_contract,
        stock_commission_per_share=args.stock_commission_per_share,
        contract_multiplier=args.contract_multiplier,
        step_hours=args.step_hours,
        n_paths=args.n_paths,
        seed=args.seed,
    )

    def clean(v):
        return None if isinstance(v, float) and math.isnan(v) else v

    rows = [{k: clean(v) for k, v in row.items()} for row in result.rules.to_dict(orient="records")]
    print(json.dumps({"premium": result.premium, "inputs": result.inputs, "rules": rows}))


if __name__ == "__main__":
    main()
