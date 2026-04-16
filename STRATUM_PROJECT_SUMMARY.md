# Stratum v7.5 — Autonomous Options Trading Platform

**Developer:** AB  
**Timeline:** March 9 – April 16, 2026 (5 weeks)  
**Scale:** 70 modules | 29,000+ lines of code | 420+ commits  
**Stack:** Node.js, Express, Railway (cloud), Discord.js, TradeStation API, CBOE API, TradingView, Twilio  
**Status:** Live in production — executing real trades autonomously

---

## What It Is

A full-stack autonomous trading system that scans the options market in real time, grades trade setups using multi-factor confluence analysis, executes orders through a brokerage API, manages risk with structural stop-losses, and tracks performance — all without manual intervention.

Built solo from scratch in 5 weeks while simultaneously using it to trade live capital.

---

## Core Architecture

### Autonomous Trading Engine (brainEngine.js — 4,300 LOC)
- Event-driven decision engine that evaluates queued trade setups against live market data every 60 seconds during market hours
- 8-factor grading system (A++ through F) combining technical analysis, options flow, gamma exposure, trend alignment, and catalyst data
- Automatic order execution with pre-trade safety checks: settlement risk, correlation limits, position sizing, daily loss limits
- Position health monitoring with dynamic stop-loss management — trails stops using market structure, not arbitrary percentages

### Order Execution & Risk Management
- Brokerage API integration (TradeStation v3) for live order placement, modification, and cancellation
- Smart order routing: StopLimit on liquid names, StopMarket on thin ones
- Post-placement verification loop confirms fills within 1.2 seconds
- Daily loss circuit-breaker halts all trading if drawdown threshold is hit
- Portfolio-level risk tracking: net delta direction, correlation exposure, max concurrent positions

### Multi-Source Signal Ingestion
- 8 independent signal scanners running on cron schedules, each implementing a different trading methodology:
  - Pre-market gap scanner with volume/float filters
  - Options flow concentration detector (unusual activity)
  - EMA crossover trend engine (Casey Method)
  - 4-hour swing setup detector (WealthPrince method)
  - Strat pattern recognition (Failed 2-Up/Down, inside bars, FTFC)
  - Credit spread opportunity scanner
  - SPY hedge monitor for portfolio protection
  - Third-party signal ingestion from Discord via polling
- All signals feed into a unified confluence scorer before reaching the execution engine

### Gamma Exposure (GEX) Engine
- Real-time gamma exposure calculator using CBOE options chain data
- Computes gamma PIN (price magnet), gamma flip (regime boundary), and gamma walls (support/resistance)
- Determines market regime (positive = mean-reverting, negative = volatile) to inform hold/exit decisions
- Integrated into trade grading and Discord alerts

### Signal Performance Journal
- Tracks every signal from generation through fill through exit
- Calculates running P&L, win rate, average return, and hold time — sliced by signal grade and source
- Auto-reconciles with brokerage order history at market close
- Persists to disk across deployments
- Designed as the proof-of-performance foundation for a signal subscription product

---

## Technical Highlights

- **Real-time system** — cron-scheduled scanners + event-driven execution loop, all running on a single Node.js process deployed to Railway
- **Mobile command interface** — custom HTML arm/disarm page served by the API, allowing full system control from a phone browser (queue management, risk toggles, live GEX panel)
- **Discord integration** — real-time alerts to multiple channels: trade fills with gamma context, morning briefs, system health, hedge alerts
- **Multi-API orchestration** — coordinates TradeStation (brokerage), CBOE (options data), TradingView (charting/indicators), Discord (alerts), Twilio (SMS fallback)
- **Resilient state management** — trade queue, signal journal, and runtime config persist to disk and survive redeployments
- **Zero-downtime config** — risk parameters, watchlists, and scanner settings adjustable via API without redeployment

---

## Key Metrics

| Metric | Value |
|--------|-------|
| Modules | 70 source files |
| Codebase | 29,000+ lines (JavaScript) |
| Commits | 420+ in 5 weeks |
| Signal Sources | 8 independent scanners |
| Grading Criteria | 8-factor confluence model |
| API Integrations | 5 external services |
| Deployment | Railway cloud, always-on |

---

## What I Learned Building This

- Designed and shipped a production system under real financial pressure — every bug had dollar consequences
- Built robust error handling for unreliable external APIs (token refresh, rate limits, partial data)
- Implemented event-driven architecture coordinating multiple async data sources into a single decision pipeline
- Managed state persistence and crash recovery in a cloud deployment without a traditional database
- Iterated rapidly: 420 commits in 5 weeks, shipping features and fixes same-day based on live trading feedback
