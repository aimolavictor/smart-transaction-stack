// The AI decision agent. Given a live network snapshot it decides the tip and the timing.
// These are model decisions, not hardcoded thresholds. The agent never touches the wire.
import { readFileSync } from 'fs';
import { MIN_TIP_LAMPORTS } from './config.mjs';

function getKey() {
  let k = process.env.OPENAI_API_KEY;
  if (!k) { try { k = (readFileSync('../.env', 'utf8').match(/^OPENAI_API_KEY=(.+)$/m) || [])[1]?.trim(); } catch {} }
  if (!k) { try { k = (readFileSync('.env', 'utf8').match(/^OPENAI_API_KEY=(.+)$/m) || [])[1]?.trim(); } catch {} }
  return k;
}

const SYSTEM = `You are the decision agent inside a Solana transaction-submission stack that lands transactions via Jito bundles.
You are given a JSON snapshot of live network conditions and must return a JSON decision.

Decide two things:
1. tipLamports: how much to tip the Jito validator for the NEXT bundle. Balance cost against landing probability. Use the real tip-floor percentiles provided: tip below p50 to save cost when the network is calm, lean toward p75-p95 when competition or urgency is high. Never below the minimum (1000 lamports). Never absurdly high (cap your reasoning around p99).
2. action: "submit" now, or "hold" if conditions are poor (no known leader in the upcoming window, network pace abnormal, or blockhash near expiry) and waiting briefly improves the odds.

Return ONLY JSON: {"tipLamports": <int>, "action": "submit"|"hold", "reason": "<one short sentence>"}.
Base the decision on the data, not fixed rules.`;

export async function decide(snapshot) {
  const key = getKey();
  if (!key) throw new Error('no OPENAI_API_KEY');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.AGENT_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(snapshot) }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });
  const j = await r.json();
  if (!j.choices) throw new Error('agent API: ' + JSON.stringify(j).slice(0, 160));
  const d = JSON.parse(j.choices[0].message.content);
  return {
    tipLamports: Math.max(MIN_TIP_LAMPORTS, Math.round(Number(d.tipLamports) || MIN_TIP_LAMPORTS)),
    action: d.action === 'hold' ? 'hold' : 'submit',
    reason: String(d.reason || '').slice(0, 200),
  };
}
