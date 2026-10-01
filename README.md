# Does the Edge Survive Costs?
### Options arbitrage checker, volatility surface calibrator and friction simulator

Central question: on US index options (SPY by default), how much theoretical edge, from butterfly spreads, calendar spreads or volatility views, survives after paying the bid-ask spread, broker commissions and delta-hedging costs?

Live demo: https://arbitrage-checkers-production.up.railway.app/

---

## Summary of Findings

Textbook finance treats arbitrage conditions and Black-Scholes pricing as frictionless. With real quotes:

1. **Costs remove almost everything.** Across ~21,000 checks on SPY, checking at mid prices gave **~4,877 theoretical arbitrage violations**. Paying the spread on every leg (buy at the ask, sell at the bid) left ~820. Adding an illustrative **$0.65 per contract per leg commission** left **~116** (~97.6% eliminated). Commission alone cut the survivors by about 7x.
2. **The survivors are probably data artifacts.** All 116 are deep in-the-money, where books are thin and indicative quotes go stale. Real edge should cluster near the money. The data feed is `indicative` (Alpaca-derived, not the exchange NBBO), so the honest status is **not proven**. The real test is a rerun with `--feed opra`.
3. **Hedging cost is U-shaped.** Rebalancing rarely leaves large replication error. Rebalancing constantly piles up transaction costs. The simulator plots total cost against rebalancing frequency and finds the bottom of the U.

---

## Architecture

A Python pipeline feeds a Next.js dashboard through JSON files.

```
                        [ Alpaca Markets API ]
                                   |
                                   v
                       backend/options_edge/
  +-------------------------------------------------------------+
  | loader.py     : clean quotes, drop stale / crossed / zero   |
  | forward.py    : forward and discount from put-call parity   |
  | iv.py         : Black-76 IV from bid, mid and ask           |
  | svi.py        : 5-parameter raw SVI smile fit               |
  | density.py    : Breeden-Litzenberger risk-neutral density   |
  | regime.py     : rolling realized vol, low/medium/high bands |
  | arbitrage.py  : butterfly and calendar checks with costs    |
  | hedging.py    : Monte Carlo delta-hedge simulator           |
  | scheduler.py  : dual-cadence data refresh                   |
  +------------------------------+------------------------------+
                                 |
                          JSON artifacts
                                 |
                                 v
                         frontend/ (Next.js)
  +-------------------------------------------------------------+
  | /          Overview : cost summary, positions marked to     |
  |                       market, payoff projections            |
  | /chain     Chain    : calls and puts, ITM shading,          |
  |                       multi-leg strategy builder            |
  | /surface   Surface  : bid-ask IV ranges, SVI fit, density   |
  | /arbitrage Arbitrage: violations vs survivors by moneyness  |
  | /hedge     Hedge    : delta-hedge simulator, cost U-curve   |
  +-------------------------------------------------------------+
```

---

## Pipeline and Math

### 1. Data cleaning and parity inversion (`loader.py`, `forward.py`)
- A quote is dropped if bid or ask is missing, zero or negative, if bid > ask, or if the spread exceeds `--max-spread-pct` (when set). Survivors get `mid`, `spread`, `spread_pct` and `quote_time`.
- Per expiry, the forward `F` and discount factor `D` come from put-call parity, which is linear in strike, via least squares across strikes:

  `C(K) - P(K) = D * (F - K)`

  No external rate or dividend input is needed.

### 2. Bid-ask implied volatility (`iv.py`)
- Inverting ITM options is ill-conditioned, so each strike uses its **out-of-the-money** leg.
- Black-76 is inverted separately against the bid, mid and ask.
- `IV_ask - IV_bid` is the cost of the spread expressed in volatility points.

### 3. SVI smile fit (`svi.py`)
Raw SVI (Gatheral), fitted to mid implied variances per expiry by least squares from a grid of starting points:

`w(k) = a + b * ( rho * (k - m) + sqrt((k - m)^2 + sigma^2) )`

- `k = ln(K / F)` is log-moneyness and `w = IV^2 * T` is total implied variance.
- `a` is the variance level and can be negative for real smiles. `b >= 0` is the wing slope. `rho` in (-1, 1) is the skew. `m` is the vertex position. `sigma > 0` is the curvature.
- The fit is constrained through the vertex variance `w_min = a + b * sigma * sqrt(1 - rho^2) >= 0`, which is the real constraint. An earlier version forced `a >= 0`, which pinned `a` at 0 on every expiry and roughly tripled the fit error.
- If the fitted vertex falls outside the observed strikes, only the curve inside the data is meaningful, not `rho` and `m` on their own. The dashboard flags this.

### 4. Risk-neutral density: Breeden-Litzenberger (`density.py`)
The market's distribution of where the underlying finishes at expiry:

`f(K) = (1 / D) * d^2 C(K) / dK^2`

- Black-76 calls are priced off the SVI smile on a uniform log-moneyness grid.
- The second derivative uses second-order finite differences. The result is clipped at zero and normalized to integrate to 1, giving the density and the cumulative probability `P(S_T <= K)`.

### 5. Arbitrage checks with friction (`arbitrage.py`)
Checks run on **market quotes, not the SVI fit**, because you can't trade a model.

- **Butterfly (convexity in strike):** for `K1 < K2 < K3` with `lambda = (K3 - K2) / (K3 - K1)`:

  `lambda * P(K1) - P(K2) + (1 - lambda) * P(K3) >= 0`
- **Calendar (monotone in maturity):** `P(K, T2) >= P(K, T1)` for `T1 < T2`, over all expiry pairs, since a far pair can survive costs when no adjacent pair does.
- Both conditions hold for American options such as SPY.
- A **violation** fails at mid. It **survives costs** if it still fails with every leg bought at the ask, sold at the bid, and every leg's commission paid. A butterfly and a calendar each trade exactly 2 contract-equivalents, so commission adds `2 * commission_per_contract` regardless of strike spacing.
- Each violation records `leg_time_skew_s`, the gap between its oldest and newest leg quote, because stale legs manufacture fake arbitrage.
- The default $0.65 per contract is illustrative, not taken from any broker's live fee schedule. Set `--commission-per-contract` to your own rate.

### 6. Market regimes and payoff projections (`regime.py`, `payoff.ts`)

**Regimes**
- From up to 2 years of daily bars, compute 30-day rolling close-to-close realized volatility:

  `sigma_realized = sqrt(252) * std( ln(S_t / S_(t-1)) )`
- The history of this series is split into tertiles: **Low**, **Medium** and **High**. The current regime is the tertile today's value falls in.
- Because the bands are tertiles of the sample, "High" means high relative to the last 2 years, not high in absolute terms. About a third of days land in each band by construction.
- A tested building block: on synthetic prices with a known 2% daily vol, the estimator must return about `0.02 * sqrt(252) = 31.7%` annualized.

**Payoff projection**
- Future paths of the underlying are simulated under the **physical measure** with GBM, using the current regime's realized vol and the historical drift.
- At each time step, every open leg is repriced with Black-76 at its market implied volatility, and the projected P&L over the holding period is shown on the Overview page.
- A seeded Mulberry32 generator with Box-Muller keeps the chart stable between renders.
- These are projections under stated assumptions, not predictions. See Known Limitations.

### 7. Delta-hedging simulator (`hedging.py`)
Prices one option at its Black-Scholes value (r = 0, q = 0, a deliberate simplification for a days-to-weeks option) and delta-hedges it along simulated GBM paths. `side` is `short` (you wrote the option and received the premium) or `long` (you bought it and paid the premium). The hedge always offsets the option's own delta, so long and short are mirror images through the same code path. With zero costs, a long's P&L is the exact negative of a short's on every path, which is the strongest test for this module.

Two rebalancing rules:
1. **Fixed interval:** rebalance every N steps (30 min, 1 hour, ... 2 days).
2. **Delta band:** rebalance when delta has drifted more than a threshold (1% to 20%) since the last hedge.

Per rule it reports:
- `transaction_cost`: mean slippage paid (half the spread per share per rebalance, plus commissions)
- `replication_error`: standard deviation of the frictionless hedging P&L
- `total_cost = transaction_cost + replication_error`

Transaction cost grows without bound as rebalancing gets more frequent, because a diffusion has infinite total variation. Replication error stays bounded even with no rebalancing. So a finite minimum exists, and where it falls depends on the spread relative to the option's gamma.

For SPY's real penny spread, the minimum is finer than is practical to grid on demand. `default_rules` therefore uses an illustrative `half_spread = 0.05`, so the minimum lands inside a grid that runs in about 2 seconds. This is adjustable and disclosed in the tool.

Commissions: `option_commission_per_contract` (default $0.65) is charged once when the option is opened, so it shifts every rule's total by the same amount. `stock_commission_per_share` (default $0) is charged on every rebalance, so frequent rebalancing pays it more times.

### 8. Positions and live refresh
- On the Chain page, **Buy** or **Sell** on any contract opens the Hedge page with strike, expiry, spot and SVI-fitted vol pre-filled.
- **Sell to open** and **Buy to open** record a position (entry at the bid for a short, the ask for a long) to `localStorage`. This is a single-user tool, so there is no database. The Overview page marks open positions to what it would cost to close now, with correctly signed P&L, and moves closed ones to a realized history.
- The scheduler fetches from Alpaca every 5 minutes and recomputes IV, SVI and arbitrage every 2 minutes in between, using the current time as the valuation time, so time-to-expiry effects keep updating.

---

## Known Limitations

- **Data:** the default feed is `indicative`, not the exchange NBBO. The result above is not final until rerun on OPRA data.
- **Illustrative costs:** commission and half-spread defaults are stand-ins, not live broker numbers.
- **Hedge model:** GBM paths with r = 0 and q = 0 and constant volatility.
- **Payoff projection:** drift is estimated from about 2 years of history and is noisy. Implied vols are held fixed along each path, so surface dynamics are not modeled.
- **Regimes:** backward-looking and relative to the sample. They don't use implied vol, which is forward-looking.

---

## Tech Stack

- **Backend:** Python 3.11+, `numpy`, `scipy`, `pandas`, `pyarrow`, `alpaca-py`
- **Frontend:** Next.js 15 (App Router), React 19, TypeScript, CSS tokens and themes, custom SVG charts
- **Orchestration:** `supervisord` runs the Python scheduler and the Next.js server in one Docker container

---

## Getting Started

### Prerequisites
- Python 3.11+
- Node.js 20+
- A free Alpaca Markets paper account (API key and secret)

### Backend

```bash
cd backend
python -m venv .venv

# Windows PowerShell:
.\.venv\Scripts\Activate.ps1
# Linux/macOS:
source .venv/bin/activate

pip install -e ".[dev]"
cp .env.example .env     # fill in APCA_API_KEY_ID and APCA_API_SECRET_KEY
```

Run the full pipeline (snapshot, SVI, arbitrage, regime, density):

```bash
python -m options_edge.cli --symbol SPY --also-json --svi --arb --regime --density
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--symbol` | `SPY` | Any US underlying with listed options |
| `--feed` | `indicative` | `opra` = consolidated quotes (needs the OPRA agreement in the Alpaca dashboard) |
| `--max-days-to-expiry` | `60` | Bounds how many expiries are pulled (`0` = all) |
| `--max-spread-pct` | off | Drop quotes whose spread exceeds this fraction of mid |
| `--iv` / `--svi` / `--arb` | off | Run each stage (`--svi` implies `--iv`) |
| `--regime` / `--density` | off | Run regime detection / Breeden-Litzenberger density |
| `--commission-per-contract` | `0.65` | Broker fee per contract per leg in `--arb`; `0` excludes it |
| `--also-json` | off | Write JSON copies for the frontend |

Every snapshot row carries its `feed`, and the arbitrage summary records it, so no number can be quoted without its data source.

Keep data fresh:

```bash
python -m options_edge.scheduler --symbol SPY --fetch-interval 300 --recompute-interval 120
```

Run the hedging simulator from the CLI:

```bash
python -m options_edge.hedge_cli --spot 500 --strike 505 --option-type CE --time-to-expiry 0.08 --vol 0.16 --side short
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000. The frontend reads `backend/data/{SYMBOL}_*.json` on every request, so rerunning the pipeline shows up on refresh. The symbol comes from `CHAIN_SYMBOL` (default `SPY`).

---

## Deployment

The root [Dockerfile](./Dockerfile) and [supervisord.conf](./supervisord.conf) run the Next.js server and the Python scheduler in one container.

To deploy on Railway or Render:
1. Push the repository to GitHub.
2. Create a new service from the repository.
3. Set the environment variables `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY` and `PORT=3000`.
4. Generate a public domain on port 3000.

---

## Testing

```bash
cd backend
pytest
```

Tests use fakes and synthetic data, so no network or credentials are needed. Key tests check that the realized-vol estimator recovers a known volatility, and that a long hedge's frictionless P&L is the exact negative of a short's.

---

## Roadmap

- [ ] **OPRA feed:** rerun with consolidated NBBO quotes to see whether any survivors appear near the money
- [ ] **Surface dynamics:** evolve option prices along Monte Carlo paths with sticky-strike vs sticky-delta assumptions
- [ ] **Order book depth:** replace flat half-spread slippage with Level 2 queue simulation
- [ ] **Rates and dividends:** discrete dividends and SOFR discounting for longer-dated options
