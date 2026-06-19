// Core transaction stack: build a versioned (v0) transaction with a Jito tip, plus blockhash
// lifecycle helpers. Reuses the versioned-tx / lookup-table approach as the transaction core.
import web3 from '@solana/web3.js';
const { SystemProgram, TransactionMessage, VersionedTransaction, PublicKey, ComputeBudgetProgram } = web3;

/**
 * Build a signed v0 transaction carrying the agent's tip to a Jito tip account.
 * payloadIxs lets the same builder wrap any real workload; default is a tiny self-transfer so the
 * bundle is valid and observable on testnet at ~zero cost.
 */
export function buildTippedTx({ payer, blockhash, tipAccount, tipLamports, payloadIxs = [], computeUnits = 30000, lookupTables = [] }) {
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ...(payloadIxs.length ? payloadIxs : [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 })]),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(tipAccount), lamports: tipLamports }),
  ];
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions })
    .compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}

export const toBase64 = (tx) => Buffer.from(tx.serialize()).toString('base64');

/** Fetch a blockhash plus the height at which it expires. */
export async function freshBlockhash(conn) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  return { blockhash, lastValidBlockHeight };
}

/** Has the blockhash expired? Drives refresh-and-rebuild instead of blind resubmit. */
export async function isExpired(conn, lastValidBlockHeight) {
  const h = await conn.getBlockHeight('confirmed');
  return { expired: h > lastValidBlockHeight, height: h, expiresInBlocks: lastValidBlockHeight - h };
}
