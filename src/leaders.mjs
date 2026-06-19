// Observation layer: live slot stream + leader schedule, so the stack knows who leads the next
// slots and can detect the window where a bundle can land. Uses websocket slotSubscribe (free);
// a Yellowstone gRPC/Geyser provider can replace the slot source behind the same interface.
import web3 from '@solana/web3.js';
import { RPC_HTTP, RPC_WS, JITO_BLOCK_ENGINE } from './config.mjs';
const { Connection } = web3;

export class LeaderTracker {
  constructor() {
    this.conn = new Connection(RPC_HTTP, { wsEndpoint: RPC_WS, commitment: 'confirmed' });
    this.currentSlot = 0;
    this.slotTimes = [];
    this.bySlotIndex = null;
    this.epochStartSlot = 0;
    this._sub = null;
  }

  async start() {
    await this.loadSchedule();
    this.currentSlot = await this.conn.getSlot('confirmed');
    this.lastSlotAt = Date.now();
    this._subscribe();
    // reconnection watchdog: if the stream goes quiet (ws drop), re-subscribe.
    this._watchdog = setInterval(() => {
      if (Date.now() - this.lastSlotAt > 8000) { this._reconnects = (this._reconnects || 0) + 1; this._subscribe(); }
    }, 5000);
    return this;
  }

  _subscribe() {
    if (this._sub != null) { try { this.conn.removeSlotChangeListener(this._sub); } catch {} }
    this._sub = this.conn.onSlotChange((info) => {
      // backpressure: handler is O(1) and the buffer is bounded, so a fast stream can't pile up.
      this.currentSlot = info.slot;
      this.lastSlotAt = Date.now();
      this.slotTimes.push(this.lastSlotAt);
      if (this.slotTimes.length > 64) this.slotTimes.shift();
    });
  }

  async loadSchedule() {
    const epoch = await this.conn.getEpochInfo();
    this.epochStartSlot = epoch.absoluteSlot - epoch.slotIndex;
    const sched = await this.conn.getLeaderSchedule(); // { leaderIdentity: [slotIndex,...] } relative to epoch start
    const bySlot = new Map();
    for (const [leader, idxs] of Object.entries(sched || {})) for (const i of idxs) bySlot.set(i, leader);
    this.bySlotIndex = bySlot;
  }

  leaderForSlot(absSlot) {
    return this.bySlotIndex?.get(absSlot - this.epochStartSlot) ?? null;
  }

  upcomingLeaders(n = 8) {
    const out = [];
    for (let s = this.currentSlot + 1; s <= this.currentSlot + n; s++) out.push({ slot: s, leader: this.leaderForSlot(s) });
    return out;
  }

  /** Mean ms between recent slots — a live read on network pace. */
  avgSlotMs() {
    if (this.slotTimes.length < 3) return null;
    const span = this.slotTimes.at(-1) - this.slotTimes[0];
    return Math.round(span / (this.slotTimes.length - 1));
  }

  /** Jito's next scheduled (Jito-enabled) leader, if the block engine exposes it over HTTP. */
  async nextJitoLeader() {
    for (const path of ['/api/v1/getNextScheduledLeader', '/api/v1/bundles']) {
      try {
        const r = await fetch(JITO_BLOCK_ENGINE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNextScheduledLeader', params: [] }) });
        const j = await r.json();
        if (j.result) return j.result;
      } catch { /* try next */ }
    }
    return null;
  }

  stop() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._sub != null) { try { this.conn.removeSlotChangeListener(this._sub); } catch {} this._sub = null; }
  }
}
