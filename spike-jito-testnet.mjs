// Spike: prove we can submit a REAL Jito bundle on testnet for $0 and track its lifecycle.
// No gRPC auth — uses Jito's permissionless HTTP JSON-RPC. Tx built with web3.js v1.
import web3 from '@solana/web3.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
const { Connection, Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } = web3;

const RPC = 'https://api.testnet.solana.com';
const BE = 'https://testnet.block-engine.jito.wtf';
const KP = '.testnet-keypair.json';

const log = (...a) => console.log(...a);
async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json().catch(() => ({ httpError: r.status }));
  return j;
}

// 1. keypair (persisted, free)
let kp;
if (existsSync(KP)) { kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KP, 'utf8')))); }
else { kp = Keypair.generate(); writeFileSync(KP, JSON.stringify([...kp.secretKey])); }
log('wallet:', kp.publicKey.toBase58());

const conn = new Connection(RPC, 'confirmed');

// 2. fund from free testnet faucet if low
let bal = await conn.getBalance(kp.publicKey);
log('balance:', bal / LAMPORTS_PER_SOL, 'SOL');
if (bal < 0.05 * LAMPORTS_PER_SOL) {
  log('requesting free testnet airdrop...');
  try {
    const sig = await conn.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    bal = await conn.getBalance(kp.publicKey);
    log('airdrop ok, balance:', bal / LAMPORTS_PER_SOL, 'SOL');
  } catch (e) { log('airdrop failed (rate limit?):', e.message); }
}
if (bal < 10000) { log('STOP: no testnet SOL — try the web faucet https://faucet.solana.com (testnet) for', kp.publicKey.toBase58()); process.exit(0); }

// 3. Jito tip accounts (permissionless)
let tipAccounts = [];
for (const path of ['/api/v1/getTipAccounts', '/api/v1/bundles']) {
  const j = await rpc(BE + path, 'getTipAccounts', []);
  if (j.result?.length) { tipAccounts = j.result; log('getTipAccounts via', path, '->', j.result.length, 'accounts'); break; }
  log('getTipAccounts via', path, '->', JSON.stringify(j).slice(0, 160));
}
if (!tipAccounts.length) { log('STOP: could not fetch tip accounts'); process.exit(1); }
const tipAccount = new PublicKey(tipAccounts[0]);

// 4. build a v0 tx with a small Jito tip (1000 lamports min) + a self-transfer
const { blockhash } = await conn.getLatestBlockhash('confirmed');
const ixs = [
  SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 }),
  SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: tipAccount, lamports: 1000 }),
];
const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
const tx = new VersionedTransaction(msg);
tx.sign([kp]);
const b64 = Buffer.from(tx.serialize()).toString('base64');
log('built v0 tx, tip=1000 lamports to', tipAccount.toBase58());

// 5. send the bundle
let bundleId;
for (const path of ['/api/v1/bundles', '/api/v1/sendBundle']) {
  const j = await rpc(BE + path, 'sendBundle', [[b64], { encoding: 'base64' }]);
  if (j.result) { bundleId = j.result; log('sendBundle via', path, '-> bundleId', bundleId); break; }
  log('sendBundle via', path, '->', JSON.stringify(j).slice(0, 220));
}
if (!bundleId) { log('STOP: bundle not accepted'); process.exit(1); }

// 6. track lifecycle
log('--- tracking lifecycle ---');
for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 2500));
  const inflight = await rpc(BE + '/api/v1/getInflightBundleStatuses', 'getInflightBundleStatuses', [[bundleId]]);
  const status = await rpc(BE + '/api/v1/getBundleStatuses', 'getBundleStatuses', [[bundleId]]);
  const inf = inflight.result?.value?.[0]?.status ?? JSON.stringify(inflight).slice(0, 120);
  const st = status.result?.value?.[0];
  log(`t+${(i + 1) * 2.5}s  inflight=${inf}  ${st ? 'confirmation=' + st.confirmation_status + ' slot=' + st.slot : ''}`);
  if (st?.confirmation_status === 'finalized' || st?.confirmation_status === 'confirmed') { log('LANDED ✓'); break; }
}
log('spike done.');
