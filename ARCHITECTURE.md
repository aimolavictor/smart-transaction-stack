# Smart Transaction Stack — Architecture

A transaction infrastructure stack that observes Solana in real time, decides how and when to
submit, lands transactions through Jito bundles, and tracks every submission through its full
lifecycle. An AI agent owns the tip and timing decisions; the core stack owns construction,
submission, and failure handling. The two are cleanly separated.

> Runs on **testnet** end to end at zero cost. Jito bundle submission is free and permissionless,
> and the lifecycle API needs no funds. Successful (landed) bundles use free faucet testnet SOL.

## High-level flow

```
            ┌─────────────────────────────────────────────────────────┐
            │                     OBSERVE (real time)                   │
            │  slot stream  ·  leader schedule  ·  Jito tip floor  ·    │
            │  recent landing rate  ·  blockhash freshness             │
            └───────────────┬─────────────────────────────────────────┘
                            │  network state snapshot
                            ▼
            ┌─────────────────────────────┐     decisions (not hardcoded)
            │        AI AGENT             │  ── tip lamports ──┐
            │  reasons over live state    │  ── submit / hold ─┤
            └─────────────────────────────┘                    │
                            ▲                                   ▼
            ┌───────────────┴─────────────────────────────────────────┐
            │                  CORE TRANSACTION STACK                  │
            │  build v0 tx (+ ALT)  ·  attach tip  ·  refresh blockhash│
            │  submit Jito bundle  ·  track lifecycle  ·  retry/classify│
            └───────────────┬─────────────────────────────────────────┘
                            ▼
                     lifecycle log (JSONL)
        slot · commitment progression · timestamps · tip · failure class
```

## Components

### 1. Observation layer (`leaders`, `network`)
- **Slot stream:** live current-slot updates via `slotSubscribe` (websocket). Pluggable with a
  Yellowstone gRPC / Geyser provider where one is available; the interface is the same.
- **Leader schedule:** `getLeaderSchedule` mapped to upcoming slots, so we know which validator
  leads each slot and can detect the **leader window** where a bundle can actually land.
- **Network conditions:** observed slot pace, recent bundle landing rate, blockhash age.

### 2. Tip intelligence (`tipfloor` + agent)
- Pulls **real recent tip data** from Jito's tip-floor API and the live tip accounts.
- No hardcoded tip. The agent reads the current tip distribution and network pressure and decides
  an amount that balances **cost vs landing probability**.

### 3. AI agent (`agent`)
- Given a network-state snapshot, returns two decisions with reasoning:
  - **tip** (lamports) for the next bundle, and
  - **timing**: submit now, or hold until a better leader window / calmer conditions.
- Reasoning comes from the model, not from `if` thresholds. The agent layer never touches the wire;
  it only emits decisions the core stack executes.

### 4. Core transaction stack (`builder`, `jito`)
- Builds a **versioned (v0) transaction**, optionally compressing accounts with an **Address Lookup
  Table**, and attaches the tip transfer to a Jito tip account.
- **Blockhash lifecycle:** fetches a fresh blockhash, detects expiry, and **refreshes + rebuilds**
  on expiry instead of blindly resubmitting.
- **Submission:** sends the bundle to the Jito Block Engine (validated, permissionless HTTP path).

### 5. Lifecycle tracker + logger (`lifecycle`, `logger`)
- Polls inflight and finalized bundle status, recording the progression
  **Submitted → Pending → Processed → Confirmed → Finalized**, or the failure.
- Each log entry: bundle id, slot numbers, commitment progression, timestamps, tip amount, and a
  **failure classification** (auction-lost, leader-skip, blockhash-expired, insufficient-funds).
- Produces the required log of **≥10 real submissions including ≥2 failures**. Slot numbers are real
  and cross-referenceable on-chain.

## Failure handling (required, not optional)

| Failure | Detection | Response |
|---|---|---|
| Auction lost / not selected | inflight status `Failed`, no landed slot | reclassify, optionally re-tip and retry |
| Leader skipped slot | expected leader slot passes without inclusion | wait for next Jito leader window |
| Blockhash expired | status + blockhash age check | refresh blockhash, rebuild, resubmit |
| Insufficient funds | pre-submit balance check / sim | abort with clear classification |

## Tech

TypeScript-style ESM on `@solana/web3.js` v1 · Jito Block Engine HTTP JSON-RPC (`sendBundle`,
`getInflightBundleStatuses`, `getBundleStatuses`, `getTipAccounts`) · Jito tip-floor API · OpenAI
for the agent. Cluster: Solana **testnet** (free).

## Why this design

The bounty rewards real understanding of how transactions move through the network, not a happy
path. So the stack is built around the parts that actually decide whether a transaction lands:
**who leads the next slots, what the market is tipping, and whether the blockhash is still good.**
The AI agent sits exactly where judgement matters (tip and timing) and nowhere else, which keeps the
core deterministic, testable, and honest about its failures.
