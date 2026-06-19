// Central config. Testnet by default; everything overridable by env so the same stack runs on
// mainnet without code changes.
export const RPC_HTTP = process.env.RPC_HTTP || 'https://api.testnet.solana.com';
export const RPC_WS = process.env.RPC_WS || 'wss://api.testnet.solana.com';
export const JITO_BLOCK_ENGINE = process.env.JITO_BE || 'https://testnet.block-engine.jito.wtf';
export const JITO_TIP_FLOOR = process.env.JITO_TIP_FLOOR || 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';
export const CLUSTER = process.env.CLUSTER || 'testnet';
export const KEYPAIR_PATH = process.env.KEYPAIR_PATH || '.testnet-keypair.json';
export const MIN_TIP_LAMPORTS = 1000; // Jito documented minimum
