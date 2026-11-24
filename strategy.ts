// Early-flow sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// One small buy per coin, decided in the first seconds after its CreateEvent,
// only when the opening tape looks like genuine dispersed demand. Every
// position is then managed to a fast exit: a take-profit, a stop loss, a
// trailing stop, a short maximum hold, an exit when the creator sells, and
// a stale exit. A pacing guardrail keeps the run above the minimum bar
// (a >= 0.01 SOL round trip on >= 20 coins) with tiny probe round trips
// when the bot's own filled coins lag the pace.
//
// Pure function of the batches it is fed: no clock, no randomness, no I/O,
// integer (bigint) money math, insertion-ordered maps only — so the two
// graded executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest/oldest age (slots since CreateEvent) at which a first buy may be decided. */
  maxAge: number;
  /** Lamports aimed at per coin (each reply is still capped at 1% of real SOL). */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: bigint;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Distinct non-creator buyers before entry: at least this many, at most this many. */
  minBuyers: number;
  maxBuyers: number;
  /** Buy trades seen before entry, at least. */
  minBuyTrades: number;
  /** Creator's own buys in the opening tape: at most this (lamports). */
  maxDevBuyLamports: bigint;
  /** Net flow (buys minus sells, lamports) in the opening tape, at least. */
  minNetFlowLamports: bigint;
  /** Lamports sold by others / lamports bought, at most (bps). */
  maxSellRatioBps: bigint;
  /** Price now over the create price, at most (bps over 10000). */
  maxRunupBps: bigint;
  /** Slippage allowed on buys / sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Exit when the liquidation value is this far over its cost (bps). */
  tpBps: bigint;
  /** Exit when it is this far under its cost (bps). */
  slBps: bigint;
  /** Trailing stop: once up at least this (bps), exit on a fall of this (bps) from the best value. */
  trailArmBps: bigint;
  trailBps: bigint;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** After an exit, ignore the coin for this many slots. */
  cooldownSlots: number;
  /** Most SOL at cost across all positions at once (lamports). */
  maxExposureLamports: bigint;
  /** Guardrail pacing: target coins / fills over the window, window length (seconds of block time). */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Probe round-trip size (lamports) and most probes open at once. */
  probeLamports: bigint;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 1,
  stakeLamports: 15_000_000n,
  minBuyLamports: 10_000_000n,
  minRealSol: 300_000_000n,
  maxRealSol: 30_000_000_000n,
  minBuyers: 5,
  maxBuyers: 10,
  minBuyTrades: 2,
  maxDevBuyLamports: 2_500_000_000n,
  minNetFlowLamports: 20_000_000n,
  maxSellRatioBps: 5000n,
  maxRunupBps: 10000n,
  buySlippageBps: 2000,
  sellSlippageBps: 10000,
  tpBps: 1500n,
  slBps: 1200n,
  trailArmBps: 1000n,
  trailBps: 1500n,
  maxHold: 40,
  staleSlots: 200,
  cooldownSlots: 150,
  maxExposureLamports: 4_000_000_000n,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 86400,
  probeLamports: 12_000_000n,
  maxProbes: 1,
};

const BPS = 10_000n;
/** Curve fees on a sell: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n || vq <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Opening {
  createSlot: number;
  creator: string;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<string>;
  buyTrades: number;
  bought: bigint;
  sold: bigint;
  lastTradeSlot: number;
  /** Decided for good: bought, filtered out, or aged out. */
  decided: boolean;
  lastExitSlot: number;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Best liquidation value seen (lamports). */
  best: bigint;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Opening>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const openingOf = (mint: Pubkey): Opening => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        createSlot: -1,
        creator: '',
        vq0: 0n,
        vt0: 0n,
        devBuy: 0n,
        devSold: false,
        buyers: new Set(),
        buyTrades: 0,
        bought: 0n,
        sold: 0n,
        lastTradeSlot: -1,
        decided: false,
        lastExitSlot: -1e12,
        complete: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Entry filter on a coin's opening tape at slot `now`. */
  const entryOk = (c: Opening, now: number, rq: bigint, priceNum: bigint, priceDen: bigint): boolean => {
    if (c.createSlot < 0 || now - c.createSlot > p.maxAge) return false;
    if (rq < p.minRealSol || rq > p.maxRealSol) return false;
    if (c.devSold || c.devBuy > p.maxDevBuyLamports) return false;
    if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) return false;
    if (c.buyTrades < p.minBuyTrades) return false;
    if (c.bought - c.sold < p.minNetFlowLamports) return false;
    if (c.bought > 0n && (c.sold * BPS) / c.bought > p.maxSellRatioBps) return false;
    // Run-up vs create price: (vq/vt) / (vq0/vt0) - 1 <= maxRunupBps.
    if (c.vq0 > 0n && c.vt0 > 0n && priceNum > 0n && priceDen > 0n) {
      const up = ((priceNum * c.vt0 - c.vq0 * priceDen) * BPS) / (c.vq0 * priceDen);
      if (up > p.maxRunupBps) return false;
    }
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tx = state.txFeeLamports();
      const cap = state.hello.caps.max_orders_per_batch;
      const orders: OrderInput[] = [];

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = openingOf(e.mint);
          c.createSlot = e.slot;
          c.creator = e.creator;
          c.vq0 = BigInt(e.virtual_quote_reserves);
          c.vt0 = BigInt(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = openingOf(e.mint);
          const sol = BigInt(e.sol_amount);
          if (e.user === c.creator) {
            if (e.is_buy) c.devBuy += sol;
            else c.devSold = true;
          } else if (e.is_buy) {
            c.buyers.add(e.user);
            c.buyTrades++;
            c.bought += sol;
          } else {
            c.sold += sol;
          }
          c.lastTradeSlot = e.slot;
          traded.add(e.mint);
        } else {
          openingOf(e.mint).complete = true;
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const cur = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') cur.buy = true;
        else cur.sell = true;
        pendingByMint.set(po.order.mint, cur);
      }
      const reserves = (mint: Pubkey): { vq: bigint; vt: bigint; rq: bigint } | null => {
        const mk = marks.get(mint);
        if (mk !== undefined) {
          return { vq: BigInt(mk.virtual_quote_reserves), vt: BigInt(mk.virtual_token_reserves), rq: BigInt(mk.real_quote_reserves) };
        }
        const curve = state.curves.get(mint);
        if (curve === undefined) return null;
        return { vq: curve.virtual_quote_reserves, vt: curve.virtual_token_reserves, rq: curve.real_quote_reserves };
      };

      // Exits first: whole-position sells.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const c = coins.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            if (c !== undefined) c.lastExitSlot = now;
          }
          continue;
        }
        if (pendingByMint.get(mint)?.sell) continue;
        const r = reserves(mint);
        if (r === null) continue;
        const value = sellValue(pos.token_amount, r.vq, r.vt) - tx;
        const cost = pos.cost_lamports;
        if (value > h.best) h.best = value;
        let exit = false;
        if (value >= (cost * (BPS + p.tpBps)) / BPS) exit = true;
        if (!exit && value <= (cost * (BPS - p.slBps)) / BPS) exit = true;
        if (!exit && h.best >= (cost * (BPS + p.trailArmBps)) / BPS && value <= (h.best * (BPS - p.trailBps)) / BPS) exit = true;
        if (!exit && now - h.openedSlot > p.maxHold) exit = true;
        if (!exit && c !== undefined && c.devSold) exit = true;
        if (!exit && c !== undefined && c.lastTradeSlot >= 0 && now - c.lastTradeSlot > p.staleSlots) exit = true;
        if (!exit) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (pendingByMint.has(mint)) continue;
        const c = coins.get(mint);
        if (c !== undefined && c.complete) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
        if (!selling) probes.set(mint, true);
      }

      // Entries: one buy per coin, in first-seen order.
      let free = state.freeCashLamports();
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0n;
      for (const [mint] of held) exposure += state.positions.get(mint)?.cost_lamports ?? 0n;
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const c = coins.get(mint);
        if (c === undefined || c.decided || c.complete) continue;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        if (now - c.lastExitSlot < p.cooldownSlots) {
          c.decided = true;
          continue;
        }
        const r = reserves(mint);
        if (r === null) continue;
        if (!entryOk(c, now, r.rq, r.vq, r.vt)) {
          // A coin that aged out or whose creator sold will never qualify: decide it for good.
          if (now - c.createSlot > p.maxAge || c.devSold) c.decided = true;
          continue;
        }
        if (slotsLeft <= 0) continue;
        const capLamports = state.maxBuyLamports(mint);
        let amount = p.stakeLamports < capLamports ? p.stakeLamports : capLamports;
        const room = p.maxExposureLamports - exposure;
        if (amount > room) amount = room;
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuyLamports) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        exposure += amount;
        slotsLeft--;
        c.decided = true;
        held.set(mint, { openedSlot: now, best: 0n });
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeLamports * BPS) / BigInt(state.hello.caps.max_order_bps_of_real_reserve);
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const c = coins.get(mint);
            if (c === undefined || c.complete) continue;
            const r = reserves(mint);
            if (r === null || r.rq < (minRq * 3n) / 2n) continue;
            if (free < p.probeLamports + 2n * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: p.probeLamports, max_slippage_bps: p.buySlippageBps });
            probes.set(mint, false);
            free -= p.probeLamports + tx;
          }
        }
      }
      return orders;
    },
  };
}
