// Orchestrator: observe -> agent decides tip+timing -> build -> submit Jito bundle -> track
// lifecycle -> log. Runs until TARGET submissions including at least MIN_FAILS failures.
import web3 from '@solana/web3.js';
import { readFileSync } from 'fs';
import { RPC_HTTP, RPC_WS, KEYPAIR_PATH, MIN_TIP_LAMPORTS } from './config.mjs';
import { LeaderTracker } from './leaders.mjs';
import { getTipAccounts, getTipFloor, sendBundle, getInflightStatus, getBundleStatus } from './jito.mjs';
import { decide } from './agent.mjs';
import { buildTippedTx, toBase64, freshBlockhash, isExpired } from './builder.mjs';
import { logEntry, LOG_FILE } from './logger.mjs';
const { Connection, Keypair, LAMPORTS_PER_SOL } = web3;

const TARGET = Number(process.env.TARGET || 10);
const MIN_FAILS = Number(process.env.MIN_FAILS || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function classify({ insufficientFunds, expired, inflight, status }) {
  if (status?.confirmation_status) return null; // landed
  if (insufficientFunds) return 'insufficient-funds';
  if (expired) return 'blockhash-expired';
  if (inflight?.status === 'Failed') return 'auction-lost-or-leader-skip';
  if (inflight?.status === 'Invalid') return 'invalid-bundle';
  return 'dropped';
}

const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))));
const conn = new Connection(RPC_HTTP, { wsEndpoint: RPC_WS, commitment: 'confirmed' });
const tracker = await new LeaderTracker().start();
const tipAccounts = await getTipAccounts();
console.log(`wallet ${kp.publicKey.toBase58()} | logging -> ${LOG_FILE} | target ${TARGET} (>=${MIN_FAILS} fails)`);

let submitted = 0, lands = 0, fails = 0;
const recentLand = [];

while (submitted < TARGET || fails < MIN_FAILS) {
  const tipFloor = await getTipFloor();
  const bh = await freshBlockhash(conn);
  const exp = await isExpired(conn, bh.lastValidBlockHeight);
  const snapshot = {
    cluster: process.env.CLUSTER || 'testnet',
    tipFloorLamports: tipFloor,
    avgSlotMs: tracker.avgSlotMs(),
    upcomingLeaders: tracker.upcomingLeaders(6).map((u) => ({ slot: u.slot, knownLeader: !!u.leader })),
    recentLandRate: recentLand.length ? recentLand.filter(Boolean).length / recentLand.length : null,
    blockhashExpiresInBlocks: exp.expiresInBlocks,
  };

  let decision;
  try { decision = await decide(snapshot); }
  catch (e) { decision = { tipLamports: Math.max(MIN_TIP_LAMPORTS, tipFloor?.p50 || 1500), action: 'submit', reason: 'agent-fallback: ' + e.message.slice(0, 60) }; }

  if (decision.action === 'hold') { console.log('HOLD -', decision.reason); await sleep(1500); continue; }

  const bal = await conn.getBalance(kp.publicKey);
  const insufficientFunds = bal < decision.tipLamports + 10000;
  const tipAccount = tipAccounts[submitted % tipAccounts.length];
  const tx = buildTippedTx({ payer: kp, blockhash: bh.blockhash, tipAccount, tipLamports: decision.tipLamports });

  const t0 = Date.now();
  const entry = {
    seq: submitted + 1, ts: new Date(t0).toISOString(), cluster: snapshot.cluster,
    tipLamports: decision.tipLamports, tipAccount, agentReason: decision.reason,
    balanceLamports: bal, blockhashExpiresInBlocks: exp.expiresInBlocks,
    bundleId: null, commitments: [], slot: null, latencyMs: null, failure: null,
  };

  let bundleId = null;
  try { bundleId = await sendBundle([toBase64(tx)]); entry.bundleId = bundleId; }
  catch (e) { entry.failure = 'submit-rejected: ' + e.message.slice(0, 80); }

  if (bundleId) {
    const seen = new Set();
    const mark = (s) => {
      if (!s || seen.has(s)) return;
      seen.add(s);
      const at = Date.now() - t0;
      entry.commitments.push({ status: s, atMs: at });
      if (s === 'processed') entry.processedAtMs = at;
      if (s === 'confirmed') entry.confirmedAtMs = at;
      if (s === 'finalized') entry.finalizedAtMs = at;
    };
    let inflight = null, status = null, landed = false;
    for (let i = 0; i < 12; i++) {
      await sleep(2500);
      inflight = await getInflightStatus(bundleId);
      mark(inflight?.status);
      if (inflight?.status === 'Landed') {
        landed = true;
        status = await getBundleStatus(bundleId);
        entry.slot = status?.slot ?? inflight.landed_slot;
        mark(status?.confirmation_status);
        // keep polling to capture the confirmation progression for the processed/confirmed delta
        for (let k = 0; k < 6 && status?.confirmation_status !== 'finalized'; k++) {
          await sleep(2500);
          status = await getBundleStatus(bundleId);
          mark(status?.confirmation_status);
        }
        break;
      }
      if (inflight?.status === 'Failed' || inflight?.status === 'Invalid') break;
    }
    entry.latencyMs = Date.now() - t0;
    if (entry.processedAtMs != null && entry.confirmedAtMs != null) entry.confirmedMinusProcessedMs = entry.confirmedAtMs - entry.processedAtMs;
    entry.failure = classify({ insufficientFunds, expired: exp.expired, inflight, status });
    if (landed) { lands++; recentLand.push(true); } else { fails++; recentLand.push(false); }
  } else {
    if (insufficientFunds && entry.failure?.startsWith('submit-rejected')) entry.failure = 'insufficient-funds';
    fails++; recentLand.push(false);
  }

  submitted++;
  if (recentLand.length > 10) recentLand.shift();
  logEntry(entry);
  console.log(`#${entry.seq} ${entry.failure ? 'FAIL(' + entry.failure + ')' : 'LANDED slot ' + entry.slot} tip=${entry.tipLamports} [${entry.commitments.map((c) => c.status).join(' > ') || '-'}] "${entry.agentReason}"`);
  await sleep(600);
}

console.log(`\ndone: ${submitted} submissions | ${lands} landed | ${fails} failed | log: ${LOG_FILE}`);
tracker.stop();
process.exit(0);
