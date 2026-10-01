# Does the Edge Survive Costs? 
### Real-Time Options Arbitrage Engine, Volatility Surface Calibrator & Friction Simulator

Central quantitative question: On US index options (SPY by default), how much theoretical edge—from butterfly spreads, calendar spreads, or implied volatility models—actually survives after paying market bid-ask spreads, broker commissions, and dynamic hedging slippage?

---

## 🎯 Executive Summary & Real-World Findings

Textbook finance treats arbitrage conditions and Black-Scholes pricing as frictionless guarantees. In production:
1. **The Friction Reality Check:** Across ~21,000 live option checks on SPY, standard mid-quote checking yielded **~4,877 theoretical arbitrage violations**. Once crossed quotes (buying at the ask, selling at the bid) and an illustrative **$0.65/contract per leg broker commission** were accounted for, that number collapsed to **~116 survivors** (~97.6% eliminated).
2. **The Liquidity Mirage:** Every single one of the remaining survivors clustered in deep in-the-money (ITM) options on indicative quotes. Deep ITM options have wide spreads, thin books, and stale quotes—meaning they are data artifacts of stale indicative feeds rather than executable alpha.
3. **The Hedging Tradeoff (U-Curve):** Infrequent rebalancing leaves huge unhedged replication variance (gamma/vol risk), while hyper-frequent rebalancing accumulates continuous transaction costs (proportional to total variation of Brownian motion). The engine simulates and reveals the empirical bottom of this U-shaped total cost curve.

---

## 🏛️ Architecture Overview

The system operates as a hybrid quantitative pipeline (Python) coupled with an analytical web cockpit (Next.js / TypeScript):

```
                        [ Alpaca Markets API ]
                                   │
                                   ▼
                       backend/options_edge/
  ┌─────────────────────────────────────────────────────────────┐
  │ • loader.py       : Clean quotes, filter staleness & crossed│
  │ • forward.py      : Linear put-call parity discount & F     │
  │ • iv.py           : Black-76 inverted IV ranges (bid/mid/ask│
  │ • svi.py          : 5-parameter raw SVI smile calibration   │
  │ • density.py      : Breeden-Litzenberger risk-neutral PDF   │
  │ • regime.py       : 2-yr historical realized-vol clustering │
  │ • arbitrage.py    : Butterfly & calendar checks with costs  │
  │ • hedging.py      : Monte Carlo dynamic delta-hedge engine  │
  │ • scheduler.py    : Dual-cadence continuous data updater    │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                     Parquet / JSON Artifacts
                                 │
                                 ▼
                         frontend/ (Next.js)
  ┌─────────────────────────────────────────────────────────────┐
  │ • / (Overview)    : Cost summary, positions marked-to-market│
  │                     & physical-measure payoff forecasts     │
  │ • /chain          : Cleaned chains, ITM shading, custom     │
  │                     multi-leg strategy builder              │
  │ • /surface        : Bid-Ask IV ranges, SVI fit & BL density │
  │ • /arbitrage      : Ranked violations, moneyness breakdown  │
  │ • /hedge          : Live Monte Carlo delta-hedge simulator  │
  └─────────────────────────────────────────────────────────────┘
```

---

## ⚡ Core Pipeline & Mathematical Framework

### 1. Data Cleaning & Parity Inversion (`loader.py`, `forward.py`)
- **Cleaning Filters:** Quotes are excluded if bid or ask is zero/negative, bid > ask, or spread exceeds a user-configured threshold (`--max-spread-pct`).
- **Forward & Discount Derivation:** Forward price ($F$) and discount factor ($D$) are extracted per expiry directly from put-call parity across liquid strikes via linear regression:
  $$C(K) - P(K) = D \cdot (F - K)$$
  No external yield curves or dividend yield feeds required.

### 2. Bid-Ask Implied Volatility Inversion (`iv.py`)
- ITM option pricing inversion is numerically ill-conditioned. The pipeline inverts **only out-of-the-money (OTM) legs** using Black-76.
- Inversion runs separately across the **Bid**, **Mid**, and **Ask** prices.
- The difference $\Delta\text{IV} = \text{IV}_{\text{ask}} - \text{IV}_{\text{bid}}$ captures the true transaction cost expressed in volatility points.

### 3. SVI Volatility Surface Calibration (`svi.py`)
Fits Jim Gatheral's 5-parameter raw Stochastic Volatility Inspired (SVI) model to mid-quote implied variances per expiry:
$$w(k) = a + b \left( \rho(k - m) + \sqrt{(k - m)^2 + \sigma^2} \right)$$
- $k = \ln(K/F)$: log-moneyness.
- $w(k) = \sigma_{\text{implied}}^2 \cdot T$: total implied variance.
- **Parameters:**
  - $a$: Baseline variance level (can be negative for real smiles).
  - $b \ge 0$: Wing slope / steepness.
  - $\rho \in (-1, 1)$: Smile skew ($\rho < 0$ indicates puts trade richer than calls).
  - $m$: Horizontal coordinate of the smile vertex.
  - $\sigma > 0$: Vertex curvature / smoothing.
- **Arbitrage Constraint:** Constrained via minimum vertex variance $w_{\min} = a + b\sigma\sqrt{1-\rho^2} \ge 0$.

### 4. Risk-Neutral Density: Breeden-Litzenberger (`density.py`)
Extracts the market's state-price distribution of where the underlying asset will finish at expiration:
$$f(K) = \left. \frac{1}{D} \frac{\partial^2 C(K)}{\partial K^2} \right|_{K}$$
- Evaluated along a uniform log-moneyness grid using Black-76 calls priced off the calibrated SVI smile.
- Second derivatives computed via 2nd-order finite differences, zero-clipped, and normalized to integrate to 1 (recovering density and cumulative probability $P(S_T \le K)$).

### 5. Arbitrage Checking with Friction (`arbitrage.py`)
Evaluates structural no-arbitrage conditions across market quotes:
- **Butterfly Spread (Convexity in Strike):**
  For strikes $K_1 < K_2 < K_3$ with $\lambda = \frac{K_3 - K_2}{K_3 - K_1}$:
  $$\lambda P(K_1) - P(K_2) + (1 - \lambda) P(K_3) \ge 0$$
- **Calendar Spread (Monotonicity in Expiry):**
  For expiries $T_1 < T_2$ at the same strike:
  $$P(K, T_2) \ge P(K, T_1)$$
- **Friction Execution Test:**
  To test if a violation can be monetized in practice, every leg crosses the market (bought at ask, sold at bid) and pays a configurable commission per leg:
  $$\text{Exec Value} = \sum_{\text{sold}} \text{bid}_i - \sum_{\text{bought}} \text{ask}_j - (\text{legs} \times \text{commission})$$
  A trade only survives if $\text{Exec Value} > 0$.
- **Quote Time Skew ($\Delta t$):** Records the timestamp gap between the earliest and latest leg quote to prevent flagging phantom arbitrage created by quote latency.

### 6. Market Volatility Regimes & Payoff Projections (`regime.py`, `payoff.ts`)
- **Regime Detection:** Ingests up to 2 years of daily underlying bars and computes a 30-day rolling realized (close-to-close) volatility:
  $$\sigma_{\text{realized}} = \sqrt{252} \times \text{std}(\ln(S_t / S_{t-1}))$$
- **Clustering:** Segments the historical distribution into tertiles (**Low**, **Medium**, **High** volatility regimes) and tracks current historical mean volatility and drift.
- **Payoff Simulation:** Projects expected P&L trajectories over holding time:
  - *Physical Measure ($P$):* Forward paths of the underlying are generated via Monte Carlo GBM driven by the current regime's realized vol and historical drift.
  - *Option Repricing:* At each time step, all open legs are repriced using Black-76 with their respective market implied volatilities.
  - *Deterministic Box-Muller PRNG:* Uses seeded Mulberry32 pseudo-randomness for stable UI rendering without frame-to-frame jitter.

### 7. Dynamic Delta-Hedging Simulator (`hedging.py`)
Simulates the operational cost of managing short or long options along geometric Brownian motion paths under two rebalancing paradigms:
1. **Fixed-Interval Rebalancing:** Rebalancing at discrete intervals (e.g. 30 min, 1 hr, 4 hr, 1 day, 2 days).
2. **Delta-Band Triggering:** Rebalancing only when the position's delta drifts by more than a threshold $\Delta_{\text{drift}} \in [1\%, 20\%]$.
- **Cost Metrics:**
  - $\text{Transaction Cost}$: Total slippage and commission incurred by rebalancing trades.
  - $\text{Replication Error}$: Standard deviation of frictionless P&L (unhedged gamma noise).
  - $\text{Total Cost} = \text{Transaction Cost} + \text{Replication Error}$.

---

## 💻 Tech Stack

- **Backend:** Python 3.11+, `numpy`, `scipy`, `pandas`, `pyarrow` (Parquet I/O), `alpaca-py`.
- **Frontend:** Next.js 15 (App Router), React 19, TypeScript, Vanilla CSS (tokens & themes, custom SVG dataviz).
- **Process & Orchestration:** `supervisord` managing Python scheduler alongside Next.js server in a Docker container.

---

## 🚀 Getting Started Locally

### Prerequisites
- Python 3.11+
- Node.js 20+
- Alpaca Markets paper trading account (Free API key & secret)

### 1. Backend Setup

```bash
cd backend
python -m venv .venv

# Activate virtual environment
# Windows PowerShell:
.\.venv\Scripts\Activate.ps1
# Linux/macOS:
source .venv/bin/activate

pip install -e ".[dev]"

# Configure credentials
cp .env.example .env
# Edit .env and supply your APCA_API_KEY_ID and APCA_API_SECRET_KEY
```

#### Run the End-to-End Pipeline
Fetch data, calibrate SVI, compute Breeden-Litzenberger density, and test arbitrage:
```bash
python -m options_edge.cli --symbol SPY --also-json --svi --arb --regime --density
```

#### Run the Continuous Scheduler
Keep the data fresh continuously (fetches Alpaca every 5m, updates time-dependent IV/arbitrage every 2m):
```bash
python -m options_edge.scheduler --symbol SPY --fetch-interval 300 --recompute-interval 120
```

#### Run Hedging Simulator via CLI
```bash
python -m options_edge.hedge_cli --spot 500 --strike 505 --option-type CE --time-to-expiry 0.08 --vol 0.16 --side short
```

### 2. Frontend Setup

In a new terminal:
```bash
cd frontend
npm install
npm run dev
```
Open **`http://localhost:3000`** in your browser.

---

## 🚢 Deployment (Docker & Container Services)

The application includes a root [Dockerfile](file:///e:/Algo%20and%20Python/project/Dockerfile) and [supervisord.conf](file:///e:/Algo%20and%20Python/project/supervisord.conf) configured to run both the Next.js server and Python scheduler simultaneously in a single container.

### Deploying to Railway or Render:
1. Push your repository to GitHub.
2. In **Railway** (or **Render**), create a new service from your GitHub repository.
3. Configure the environment variables:
   - `APCA_API_KEY_ID` = `your_alpaca_key`
   - `APCA_API_SECRET_KEY` = `your_alpaca_secret`
   - `PORT` = `3000`
4. Set public networking / generate a domain on port **3000**.

---

## 🧪 Testing

Run test suites across analytical modules without network calls (uses deterministic fixtures):
```bash
cd backend
pytest
```

---

## 📈 Future Roadmap & Research Directions

- [ ] **Direct OPRA Feed Integration:** Transition from indicative quotes to consolidated OPRA NBBO to eliminate stale quote artifacts.
- [ ] **Dynamic Surface Evolution:** Evolve forward option prices using sticky-strike vs. sticky-delta dynamics in Monte Carlo paths.
- [ ] **Order Book Depth & Queue Execution:** Replace flat half-spread slippage assumptions with Level 2 order book simulation.
- [ ] **Rate & Dividend Term Structures:** Incorporate discrete dividends and SOFR discount curves for longer DTE option universes.
