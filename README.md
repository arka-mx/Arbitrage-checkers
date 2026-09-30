# Does the edge survive costs?

Central question: on index options (SPY by default), how much of the
theoretical edge (from arbitrage or a volatility view) survives after paying
the bid-ask spread and hedging costs?

## Status

**Phase 1: clean data and surface**
- [x] Loader for the option chain (bid/ask/mid), dropping stale or zero-bid quotes.
- [x] Invert IV from bid and ask separately, so every strike gets an IV range.
- [x] Fit SVI (5 parameters) to the mid IVs.

**Phase 2: arbitrage checker with costs**
- [x] Butterfly and calendar conditions on the quoted surface.
- [x] Subtract the full bid-ask cost of every leg, *and* every leg's broker commission.
- [x] Report "X violations found, Y survive costs".

> **Result so far, and why it isn't the answer yet.** On the free Alpaca feed,
> with spread *and* a $0.65/contract commission both included: ~4,877
> violations out of ~21,000 checks, **116** surviving costs, against a
> prediction of about zero. (Spread alone, no commission, put that number at
> ~820 — adding a realistic commission cuts survivors by 7×, which is itself
> the point: "does the edge survive costs" gets a much harsher answer once
> *every* cost is counted, not just the spread.) But the feed is `indicative`
> (Alpaca-derived, not the real exchange NBBO), and every one of the 116
> survivors is deep in-the-money — real edge would cluster near the money,
> where SPY actually trades; deep ITM is exactly where thin, stale indicative
> quotes are least trustworthy. Those are data artifacts, not edge. The real
> test is a rerun on OPRA data (`--feed opra`, which needs the OPRA agreement
> signed in the Alpaca dashboard).

**Phase 3: delta-hedging simulator with costs**
- [x] Buy or sell an option (from the Chain page), hedge it under
      fixed-interval and delta-band rules, paying half the underlying's
      bid-ask spread per trade.
- [x] Plot total cost against how often you actually rebalanced; find the
      bottom of the U.
- [x] Enter and track the position: open/closed, marked to market, signed
      P&L for either direction.

**Also added: realistic transaction costs, and automatic data refresh**
- [x] Broker commission (per-contract, plus a per-share stock commission for
      hedge rebalances) added to both the arbitrage checker and the hedge
      simulator — costs were previously spread-only.
- [x] A scheduler that re-fetches from Alpaca every 5 minutes and recomputes
      IV/SVI/arbitrage every 2 minutes in between, so the dashboard stays
      live without manually rerunning the CLI.

## Layout

- `backend/`: Python pipeline, package `options_edge`
  (`alpaca_client` → `loader` → `iv` (+ `forward`, `pricing`) → `svi`, and
  `arbitrage`; `hedging` + `hedge_cli` for Phase 3).
- `frontend/`: Next.js dashboard with Overview, Chain, Vol surface, Arbitrage,
  and Hedge pages, plus an `/api/hedge` route that runs the simulator on demand.

## Backend

Data comes from [Alpaca Markets](https://alpaca.markets/). A free paper
account works; put your key/secret in `backend/.env` (see `.env.example`).

```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate   # Windows Git Bash; .venv\Scripts\Activate.ps1 in PowerShell
pip install -e ".[dev]"
cp .env.example .env            # fill in APCA_API_KEY_ID / APCA_API_SECRET_KEY

# the full pipeline: snapshot -> IV -> SVI -> arbitrage, with JSON for the frontend
python -m options_edge.cli --also-json --svi --arb

pytest                          # fakes only: no network or credentials needed
```

| Flag | Default | What it does |
|---|---|---|
| `--symbol` | `SPY` | Any US underlying with listed options |
| `--feed` | `indicative` | `opra` = real consolidated quotes (needs the OPRA agreement) |
| `--max-days-to-expiry` | `60` | Bounds how many expiries are pulled (`0` = all) |
| `--max-spread-pct` | off | Drop quotes whose spread exceeds this fraction of mid |
| `--iv` / `--svi` / `--arb` | off | Run each stage (`--svi` implies `--iv`) |
| `--commission-per-contract` | `0.65` | Broker fee per contract per leg, charged in `--arb`. Illustrative — set to your own broker's rate; `0` excludes it |
| `--also-json` | off | Write JSON copies for the frontend |

Every snapshot row carries its `feed`, and the arbitrage summary records it,
so no number can be quoted without its data source.

### Cleaning

A quote is dropped if bid or ask is missing, zero, or negative, or if bid >
ask. Survivors get `mid`, `spread`, `spread_pct`, and their `quote_time`.

### IV inversion

Per expiry, the forward and discount factor come from put-call parity via a
least-squares fit across strikes (`C − P = D·(F − K)` is linear in strike), so
no external rate or dividend input is needed. Each strike uses its
out-of-the-money leg (ITM inversion is ill-conditioned), and Black-76 is
inverted separately against the bid, mid, and ask. The gap `iv_ask − iv_bid` is
what the spread costs in vol terms.

### SVI fit

Raw SVI, `w(k) = a + b(ρ(k − m) + √((k − m)² + σ²))` with `k = ln(K/F)` and
`w = IV²·T`, fitted to the mid IVs by least squares from a grid of starting
points. The fit is parameterized by the vertex variance
`w_min = a + bσ√(1 − ρ²) ≥ 0`, which is the real constraint. `a` itself may be
negative, and for real smiles usually is. (An earlier version bounded `a ≥ 0`,
which pinned `a` at 0 on every expiry and roughly tripled the fit error.)
When the fitted vertex falls outside the observed strikes, only the curve
inside the data is meaningful, not ρ and m on their own. The dashboard flags
this.

### Arbitrage checks

Run on market quotes, not on the SVI fit: you can't trade a model.

- **Butterfly** (convexity in strike): for adjacent `K1 < K2 < K3` with
  `λ = (K3 − K2)/(K3 − K1)`, `λ·P(K1) − P(K2) + (1 − λ)·P(K3) ≥ 0`.
- **Calendar** (monotone in maturity): `P(K, T2) ≥ P(K, T1)` for `T1 < T2`,
  over all expiry pairs, since after costs a far pair can survive when no
  adjacent pair does.

Both hold for American options (SPY). A **violation** fails at mid. It
**survives costs** if it still fails with every leg bought at the ask, sold at
the bid, *and* every leg's `commission_per_contract` paid (default $0.65,
illustrative — same spirit as `half_spread` below: a stand-in for "commission
+ regulatory pass-through," not fetched from any broker's live fee schedule).
A butterfly always trades exactly 2 contract-equivalents (the wing weights
`λ` and `1−λ` sum to 1, plus the body's 1), a calendar always trades exactly
2 (one near, one far), so the commission added to `exec_value` is always
`2 × commission_per_contract` regardless of strike spacing. Each violation
also records `leg_time_skew_s`, the gap between its oldest and newest leg
quote, because stale legs manufacture fake arbitrage.

### Delta-hedging simulator

`options_edge/hedging.py` prices one option at its Black-Scholes fair value
(r=0, q=0 — a deliberate simplification for a days-to-weeks option) and
delta-hedges it along simulated GBM paths, paying `half_spread` per share on
every rebalance. It handles both directions via `side` ("short" = you wrote
the option and received the premium; "long" = you bought it and paid the
premium): the hedge always offsets the option's own delta exposure, so a
long position hedges by shorting the underlying and a short position hedges
by buying it — mirror images run through the same code path. (With zero
transaction cost, the frictionless P&L of a long is provably the exact
negative of the short's, per simulated path — the strongest test in the
suite for this.) Two rule families:

- **Fixed interval**: rebalance every N grid steps (30 min, 1 hour, ... 2 days).
- **Delta band**: rebalance whenever the option's delta has drifted more than
  a threshold (1%, 2%, ... 20%) since the last hedge.

Per rule it reports `transaction_cost` (mean slippage paid) and
`replication_error` (std of the *frictionless* hedging P&L — transaction
costs added back, isolating pure replication noise). `total_cost` is their
sum. Transaction cost provably grows without bound as rebalancing frequency
does (a diffusion's total variation is infinite); replication error is
bounded even at zero rebalancing. So a finite minimum exists in principle —
where it falls depends on the spread relative to the option's gamma. For
SPY's real penny spread that minimum sits finer than is practical to grid on
demand; `default_rules` uses an illustrative `half_spread=0.05` (a nickel, not
SPY's actual spread) so the minimum lands inside a grid that still runs in
~2 seconds. This is disclosed in the tool, and `half_spread` is adjustable.

On top of `half_spread`, two commissions are modeled: `option_commission_per_contract`
(default $0.65, illustrative — same one used in the arbitrage checker) is
charged **once**, when the option itself is opened, regardless of hedge rule
— it's a flat shift added identically to every rule's `total_cost`.
`stock_commission_per_share` (default $0 — most brokers, Alpaca included,
don't charge one for stock trades) is charged on top of `half_spread` on
**every** hedge rebalance, so it scales with how often you rebalance: more
frequent rules pay it more times over.

Try it:
```bash
python -m options_edge.hedge_cli --spot 765 --strike 770 --option-type CE --time-to-expiry 0.0822 --vol 0.157 --side short
python -m options_edge.hedge_cli --spot 765 --strike 770 --option-type CE --time-to-expiry 0.0822 --vol 0.157 --side long --option-commission-per-contract 0 --stock-commission-per-share 0.005
```

### Buy or sell an option, and track it (Phase 3, frontend)

On the **Chain** page, click **Buy** or **Sell** on any call or put to open
the **Hedge** page with that contract and direction pre-filled — strike,
expiry, spot, and volatility (the SVI-fitted IV at that strike, so it works
even for in-the-money legs the IV surface itself skips). The page adapts to
the direction throughout: "Market bid" vs "Market ask", "you'll receive" vs
"you'll pay", "Sell to open" vs "Buy to open". Adjusting volatility or
half-spread and re-running calls `/api/hedge`, a Next.js route that shells
out to `hedge_cli` with `side` included (no Alpaca credentials needed — it's
pure computation on parameters already in hand) and returns the per-rule
cost table as JSON.

Above the simulator, **Sell to open** / **Buy to open** actually records the
trade: pick a contract count, and it saves a position (entry premium =
current market bid for a short, ask for a long, × 100 × contracts) to
`localStorage` — this is a personal single-user tool, so there's no account
system or database, just the browser you're using. A **Your positions**
section on the Overview page lists every open position — tagged short or
long — marked to what it'd cost to close right now (the ask for a short, the
bid for a long), with live unrealized P&L (correctly signed for either
direction), and lets you close a position (at market or a price you enter) to
move it to a realized-P&L history. The nav's Overview link shows an
open-position count badge.

## Keeping the data fresh automatically

Everything above reads `backend/data/*.json` on every request but only
*writes* it when you run the CLI by hand. Leave this running instead:

```bash
python -m options_edge.scheduler --symbol SPY --fetch-interval 300 --recompute-interval 120
```

Two independent cadences (Ctrl+C to stop; a failed fetch or recompute is
logged and retried next tick rather than crashing):

- **Every `fetch_interval` seconds (default 300 = 5 min):** a real network
  round trip to Alpaca — contracts, live quotes, and the underlying's spot
  price. The expensive step.
- **Every `recompute_interval` seconds (default 120 = 2 min):** reruns
  IV → SVI → arbitrage against the most recently *fetched* snapshot, but
  using the current wall-clock time as the valuation time. This isn't a
  no-op between fetches: time to expiry keeps shrinking every tick, and
  IV/SVI/vol-cost are all functions of it, so those numbers visibly move
  even on unchanged quotes. (The arbitrage check itself only compares raw
  bid/ask, not time to expiry, so its numbers stay flat between fetches —
  recomputing it anyway keeps every file's timestamp consistent.) A fetch
  always triggers its own immediate recompute, so `recompute_interval` only
  governs the gaps *between* fetches.

## Frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
```

It reads `backend/data/{SYMBOL}_*.json` on every request, so rerunning the
pipeline shows up on refresh. The symbol comes from `CHAIN_SYMBOL` (default
`SPY`). Pages:

- **Overview**: the Phase 2 headline, your open/closed positions marked to market, and the bid-ask cost in vol points by days to expiry.
- **Chain**: calls and puts by strike, with ITM shading, a spot marker, and Buy/Sell actions per leg.
- **Vol surface**: the smile with bid-ask IV ranges, mid IVs, and the SVI fit, plus parameters for every expiry.
- **Arbitrage**: violations vs. survivors by moneyness, and a ranked violations table (both already commission-inclusive).
- **Hedge**: buy or sell a contract (and record the position), tune vol/half-spread, and see total hedging cost vs. rebalance frequency — the U-shaped curve, split into fixed-interval and delta-band series.

Charts follow a validated palette (colorblind-checked in light and dark),
include a hover and keyboard layer, and have a table view.
