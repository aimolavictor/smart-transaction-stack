# Smart Transaction Stack

A Solana transaction infrastructure stack that observes the network in real time, lets an AI agent
decide the tip and timing, lands transactions through **Jito bundles**, and tracks every submission
through its full lifecycle. Built for the Advanced Infrastructure Challenge.

Runs end to end on **testnet at $0** (Jito bundle submission is free and permissionless; testnet SOL
is free from the faucet). Flip the env vars to run the exact same code on mainnet.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the design and component breakdown.

## What it does

- **Observes** live slots (`slotSubscribe`, with reconnection + a Yellowstone/Geyser-pluggable
  interface), the full leader schedule, network pace, and the real Jito tip floor.
- **Decides** with an AI agent (`src/agent.mjs`): given a live network snapshot it returns the tip
  (lamports) and whether to submit or hold. These are model decisions over real data, not hardcoded
  thresholds.
- **Builds** a versioned (v0) transaction with the tip to a Jito tip account, fetching a fresh
  blockhash and refreshing-and-rebuilding on expiry.
- **Submits** real Jito bundles and **tracks** the lifecycle Submitted → Pending → Landed →
  confirmed → finalized, classifying failures.
- **Logs** every submission to `logs/lifecycle.jsonl` with slot numbers, commitment progression and
  timestamps, tip amounts, and failure classification.

## Setup

```bash
npm install
# create a wallet and fund it with free testnet SOL:
#   the wallet is auto-created at .testnet-keypair.json on first run
#   fund it at https://faucet.solana.com  (select Testnet)
export OPENAI_API_KEY=sk-...        # the AI agent (any small model; default gpt-4o-mini)
node src/main.mjs                   # runs until 10 submissions incl >=2 failures
```

Run on mainnet without code changes:

```bash
RPC_HTTP=<mainnet-rpc> RPC_WS=<mainnet-ws> JITO_BE=https://mainnet.block-engine.jito.wtf \
CLUSTER=mainnet KEYPAIR_PATH=mainnet.json node src/main.mjs
```

## Results from a real testnet run

```
10 submissions | 5 landed | 5 failed
landed slots: 416450112, 416450220, 416450296, 416450376, 416450456
each landed bundle: Pending > Landed > confirmed > finalized, AI-chosen tip 1987–10040 lamports
```

Full per-bundle records (slots, commitment timestamps, tips, failure class) are in
`logs/lifecycle.jsonl`. Slot numbers are real and cross-referenceable on a testnet explorer.

## A note on cluster

Jito's Block Engine runs on **mainnet and testnet** (not devnet), so real bundles are demonstrated on
**testnet**, where SOL is free and bundles are still real. The code is cluster-agnostic via env vars.

## The three questions, answered from this infrastructure

**1. What does the delta between `processed_at` and `confirmed_at` tell you about network health at
the time of submission?**

`processed` is the leader's optimistic, single-node view that the transaction executed; `confirmed`
means a supermajority of stake has voted on the block holding it. The delta is how long the cluster
takes to reach voting supermajority after execution. A small, stable delta means votes propagate fast
with little fork competition: a healthy, uncongested cluster. A growing or jittery delta means slow
convergence: congestion, vote lag, or competing forks at that slot, so a time-sensitive transaction is
riskier and warrants a higher tip and tighter leader targeting. In these runs the processed→confirmed
transition was effectively immediate (sub-second), consistent with a healthy testnet; the larger,
more variable gap was confirmed→finalized (rooting), which is expected since finalization waits on
~31+ further confirmations.

**2. Why should you never use `finalized` commitment when fetching a blockhash for a time-sensitive
transaction?**

A finalized blockhash is already ~31+ slots (~13+ seconds) old when you receive it. A blockhash is
only valid for 150 slots (~60s), so starting from `finalized` burns a large slice of that window
before you even submit and risks expiry mid-flight, exactly when you can least afford it. Use the
freshest valid blockhash (`confirmed`, or `processed`) to keep the transaction submittable as long as
possible. This stack fetches at `confirmed` and refreshes-and-rebuilds on expiry instead of
resubmitting a stale hash.

**3. What happens to your bundle if the Jito leader skips their slot?**

Bundles are atomic and only land if a Jito-enabled validator leads the targeted slot and includes
them. If that leader skips its slot (delinquent, or the slot is skipped/forked away), the bundle is
simply not included for that slot. Nothing is partially applied and **no tip is paid**, because
nothing landed. The bundle then either lands at a later Jito leader's slot inside its blockhash
validity window or expires unlanded. In this stack that surfaces as an `Invalid`/`Failed` inflight
status with no landed slot; the right response is to wait for the next Jito leader window (which the
agent watches for) and resubmit with a fresh blockhash, optionally raising the tip. The five failures
in the run above are exactly this case.

## Layout

```
src/config.mjs    env-driven config (cluster, endpoints)
src/leaders.mjs   slot stream + leader schedule + reconnection
src/jito.mjs      Jito Block Engine client + tip floor
src/agent.mjs     AI tip/timing decision agent
src/builder.mjs   v0 tx construction + blockhash lifecycle
src/logger.mjs    JSONL lifecycle log
src/main.mjs      orchestrator
```
