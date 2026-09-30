"""Delta-hedging simulator: what does it cost to hedge a sold option?

Simulates GBM paths for the underlying, sells one option at its theoretical
fair value, and dynamically delta-hedges it under a set of rebalancing rules
(fixed time intervals, or a delta-band trigger), paying half the underlying's
bid-ask spread — plus, optionally, a broker's actual per-share and
per-contract commissions — on every hedge trade. For each rule this reports:

  - transaction_cost: mean total slippage paid over the option's life.
  - replication_error: std of the *frictionless* hedging P&L (transaction
    costs added back) — the noise from not hedging continuously. Falls as
    rebalancing gets more frequent.
  - total_cost = transaction_cost + replication_error.

Frequent hedging beats down replication_error but racks up transaction_cost;
infrequent hedging is the reverse. total_cost vs. how often you actually
rebalanced (mean_trades — empirical, so time-based and band-based rules sit
on the same axis) traces the U-shaped tradeoff.

Model: Black-Scholes with r=0, q=0 (via ``black76_price``/``black76_delta``
with forward=spot, discount=1) — a deliberate simplification for a
days-to-weeks option, where financing/dividend drift is negligible next to
the bid-ask cost being measured. The simulation vol and the hedging vol are
the same (no vol misspecification modeled).

A genuine minimum exists in theory regardless of parameters — transaction
cost grows without bound as rebalancing frequency does (the total variation
of a diffusion is infinite), while replication error is bounded even at zero
rebalancing (it's just the payoff variance of a static position) — but where
that minimum sits depends on how wide ``half_spread`` is relative to the
option's gamma. For SPY's actual penny-wide market, the minimum turns out to
sit *finer* than is practical to grid on demand (finer than any of the rules
below reach): the model's honest answer there is "hedge as often as you can."
``default_rules`` is tuned for a half-spread wide enough (a nickel, i.e.
``half_spread=0.05``, well above SPY's usual cent) to bring that minimum
inside a grid that's still fast to compute — deliberately illustrative, not a
claim about SPY's real spread. Narrower ``half_spread`` pushes the visible
curve toward "more frequent is still better" rather than manufacturing a U
that isn't really there.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .pricing import black76_delta, black76_price

HOURS_PER_YEAR = 365.0 * 24.0


@dataclass(frozen=True)
class HedgeRule:
    label: str
    every_n_steps: int | None = None  # fixed-interval rule: rebalance every N grid steps
    band: float | None = None  # band rule: rebalance when |delta drift| exceeds this

    def __post_init__(self):
        if (self.every_n_steps is None) == (self.band is None):
            raise ValueError("HedgeRule needs exactly one of every_n_steps or band")


def simulate_gbm_paths(
    spot: float, vol: float, time_to_expiry: float, n_steps: int, n_paths: int, seed: int
) -> np.ndarray:
    """Risk-neutral GBM (drift 0) price paths, shape (n_paths, n_steps + 1)."""
    if n_steps < 1:
        raise ValueError("n_steps must be >= 1")
    dt = time_to_expiry / n_steps
    rng = np.random.default_rng(seed)
    z = rng.standard_normal((n_paths, n_steps))
    log_returns = -0.5 * vol * vol * dt + vol * np.sqrt(dt) * z
    log_paths = np.log(spot) + np.concatenate(
        [np.zeros((n_paths, 1)), np.cumsum(log_returns, axis=1)], axis=1
    )
    return np.exp(log_paths)


def _run_rule(
    paths: np.ndarray,
    remaining_t: np.ndarray,
    strike: float,
    option_type: str,
    vol: float,
    half_spread: float,
    contract_multiplier: float,
    rule: HedgeRule,
    position_sign: float,
    stock_commission_per_share: float = 0.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-path (pnl, transaction_cost, n_trades) for one hedge rule.

    ``position_sign`` is +1 for a long option (holder), -1 for a short one
    (writer). The hedge always offsets the option's own delta exposure
    (``-position_sign * delta``), so a long position hedges by shorting the
    underlying and a short position hedges by buying it — mirror images of
    the same mechanics, run through the same code path.

    Each hedge trade pays ``half_spread`` (the underlying's spread) *and*
    ``stock_commission_per_share`` (a broker fee on the shares traded, $0 by
    default — most brokers, Alpaca included, don't charge one) per share.
    """
    n_paths, n_cols = paths.shape
    n_steps = n_cols - 1
    per_share_cost = half_spread + stock_commission_per_share

    def delta_at(col: int) -> np.ndarray:
        return black76_delta(paths[:, col], strike, remaining_t[col], vol, option_type)

    cash = np.zeros(n_paths)
    txn_cost = np.zeros(n_paths)
    n_trades = np.zeros(n_paths, dtype=int)

    held = -position_sign * delta_at(0) * contract_multiplier
    cash -= held * paths[:, 0]
    step_cost = per_share_cost * np.abs(held)
    cash -= step_cost
    txn_cost += step_cost
    n_trades += 1
    last_delta = -position_sign * held / contract_multiplier  # back to raw option delta for the band check

    for col in range(1, n_steps + 1):
        current_delta = delta_at(col)
        is_last = col == n_steps
        if is_last:
            trigger = np.ones(n_paths, dtype=bool)  # always unwind at expiry
        elif rule.every_n_steps is not None:
            trigger = np.full(n_paths, col % rule.every_n_steps == 0)
        else:
            trigger = np.abs(current_delta - last_delta) >= rule.band

        target = np.where(is_last, 0.0, -position_sign * current_delta * contract_multiplier)
        traded = np.where(trigger, target - held, 0.0)

        cash -= traded * paths[:, col]
        step_cost = per_share_cost * np.abs(traded)
        cash -= step_cost
        txn_cost += step_cost
        n_trades += trigger.astype(int)

        held = np.where(trigger, target, held)
        last_delta = np.where(trigger, current_delta, last_delta)

    payoff = (
        np.maximum(paths[:, -1] - strike, 0.0)
        if option_type == "CE"
        else np.maximum(strike - paths[:, -1], 0.0)
    )
    pnl = cash + position_sign * payoff * contract_multiplier
    return pnl, txn_cost, n_trades


@dataclass
class HedgeRunResult:
    rules: pd.DataFrame  # one row per rule
    premium: float
    inputs: dict


def run_hedge_simulation(
    spot: float,
    strike: float,
    time_to_expiry: float,
    vol: float,
    option_type: str,
    half_spread: float,
    rules: list[HedgeRule],
    side: str = "short",
    option_commission_per_contract: float = 0.0,
    stock_commission_per_share: float = 0.0,
    contract_multiplier: float = 100.0,
    step_hours: float = 0.5,
    n_paths: int = 1200,
    seed: int = 7,
) -> HedgeRunResult:
    """Run every rule against the same set of simulated paths and seed.

    ``side`` is "short" (you wrote/sold the option, received the premium) or
    "long" (you bought it, paid the premium) — see ``_run_rule``.

    ``option_commission_per_contract`` is a broker fee charged once, when the
    option itself is bought or sold to open the position (independent of the
    hedge rule — it's paid regardless of how often you rebalance afterward).
    ``stock_commission_per_share`` is charged on every hedge trade in the
    underlying, on top of ``half_spread`` — see ``_run_rule``. Both default
    to 0; set them to model a specific broker's actual fee schedule.
    """
    if side not in ("short", "long"):
        raise ValueError(f"side must be 'short' or 'long', got {side!r}")
    position_sign = -1.0 if side == "short" else 1.0
    option_commission = option_commission_per_contract * (contract_multiplier / 100.0)

    n_steps = max(1, round(time_to_expiry * HOURS_PER_YEAR / step_hours))
    for rule in rules:
        if rule.every_n_steps is not None and rule.every_n_steps > n_steps:
            raise ValueError(f"{rule.label}: every_n_steps ({rule.every_n_steps}) exceeds n_steps ({n_steps})")

    paths = simulate_gbm_paths(spot, vol, time_to_expiry, n_steps, n_paths, seed)
    remaining_t = time_to_expiry - np.arange(n_steps + 1) * (time_to_expiry / n_steps)
    premium = black76_price(spot, strike, time_to_expiry, vol, option_type) * contract_multiplier

    rows = []
    for rule in rules:
        pnl, txn_cost, n_trades = _run_rule(
            paths, remaining_t, strike, option_type, vol, half_spread, contract_multiplier,
            rule, position_sign, stock_commission_per_share,
        )
        # Short: premium is received (+); long: premium is paid (-). The
        # option commission is paid either way, once, regardless of side.
        total_pnl = -position_sign * premium + pnl - option_commission
        txn_cost_with_commission = txn_cost + option_commission
        frictionless_pnl = total_pnl + txn_cost_with_commission  # add back costs to isolate replication noise
        rows.append(
            {
                "label": rule.label,
                "every_n_steps": rule.every_n_steps,
                "band": rule.band,
                "mean_trades": float(np.mean(n_trades)),
                "transaction_cost": float(np.mean(txn_cost_with_commission)),
                "replication_error": float(np.std(frictionless_pnl)),
                "mean_pnl": float(np.mean(total_pnl)),
                "std_pnl": float(np.std(total_pnl)),
            }
        )

    table = pd.DataFrame(rows)
    table["total_cost"] = table["transaction_cost"] + table["replication_error"]
    return HedgeRunResult(
        rules=table,
        premium=premium,
        inputs={
            "spot": spot, "strike": strike, "time_to_expiry": time_to_expiry, "vol": vol,
            "option_type": option_type, "side": side, "half_spread": half_spread,
            "option_commission_per_contract": option_commission_per_contract,
            "stock_commission_per_share": stock_commission_per_share,
            "contract_multiplier": contract_multiplier, "step_hours": step_hours,
            "n_steps": n_steps, "n_paths": n_paths, "seed": seed,
        },
    )


def default_rules(time_to_expiry: float, step_hours: float = 0.5) -> list[HedgeRule]:
    """A spread of fixed-interval and band rules, skipping intervals too coarse or

    too fine for T's grid. Tuned so both the interval curve and the band curve
    show their minimum within the tested range for a typical days-to-weeks
    option (see hedging.py module docstring for the cost tradeoff this traces).
    """
    n_steps = max(1, round(time_to_expiry * HOURS_PER_YEAR / step_hours))
    minute_candidates = [
        ("30 min", 30), ("1 hour", 60), ("2 hours", 120),
        ("4 hours", 240), ("8 hours", 480), ("Daily", 24 * 60), ("Every 2 days", 48 * 60),
    ]
    fixed = []
    for label, minutes in minute_candidates:
        n = round(minutes / 60 / step_hours)
        if 1 <= n <= n_steps:
            fixed.append(HedgeRule(label, every_n_steps=n))
    bands = [HedgeRule(f"Band {b:.0%}", band=b) for b in (0.01, 0.02, 0.05, 0.10, 0.20)]
    return fixed + bands
