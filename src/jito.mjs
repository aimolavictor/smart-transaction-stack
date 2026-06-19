// Jito Block Engine client (permissionless HTTP JSON-RPC) + tip-floor reader.
// Validated live on testnet: sendBundle returns a real bundle id; status endpoints report the
// real lifecycle (Pending -> Failed/Landed).
import { JITO_BLOCK_ENGINE, JITO_TIP_FLOOR } from './config.mjs';

async function be(method, params, path = '/api/v1/bundles') {
  const r = await fetch(JITO_BLOCK_ENGINE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json().catch(() => ({ error: { message: 'HTTP ' + r.status } }));
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}

/** Current Jito tip accounts (rotate; pick one per bundle). */
export const getTipAccounts = () => be('getTipAccounts', [], '/api/v1/getTipAccounts');

/** Submit a bundle of base64-encoded signed transactions. Returns the bundle id. */
export const sendBundle = (base64Txs) => be('sendBundle', [base64Txs, { encoding: 'base64' }]);

/** Fast in-flight status: Pending | Failed | Landed | Invalid, with landed_slot. */
export async function getInflightStatus(bundleId) {
  const res = await be('getInflightBundleStatuses', [[bundleId]], '/api/v1/getInflightBundleStatuses');
  return res?.value?.[0] ?? null;
}

/** Full status once processed: confirmation_status + slot + per-tx results. */
export async function getBundleStatus(bundleId) {
  const res = await be('getBundleStatuses', [[bundleId]], '/api/v1/getBundleStatuses');
  return res?.value?.[0] ?? null;
}

/**
 * Real recent tip distribution from Jito. Returns percentiles in lamports (25th/50th/75th/95th/99th)
 * or null if unavailable (e.g. testnet has thin data -> agent falls back to live-account observation).
 */
export async function getTipFloor() {
  try {
    const r = await fetch(JITO_TIP_FLOOR);
    const j = await r.json();
    const row = Array.isArray(j) ? j[0] : j;
    if (!row) return null;
    const sol = (k) => Math.round((row[k] ?? 0) * 1e9); // API reports SOL -> lamports
    return {
      p25: sol('landed_tips_25th_percentile'),
      p50: sol('landed_tips_50th_percentile'),
      p75: sol('landed_tips_75th_percentile'),
      p95: sol('landed_tips_95th_percentile'),
      p99: sol('landed_tips_99th_percentile'),
      emaP50: sol('ema_landed_tips_50th_percentile'),
    };
  } catch { return null; }
}
