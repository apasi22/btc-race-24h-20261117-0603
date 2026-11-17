// Dip-and-ride BTC bot for the make.fun bars-replay race.
//
// Idea: buy deep dips against a long rolling mean, then ride the recovery
// with a wide trailing stop. Turnover stays low on purpose: at dev-window
// pool depths a full-size round trip costs ~35 bps (4 fee + 2 slippage +
// ~11-13 price impact per leg), so the bot only trades when the dislocation
// is large and lets winners run instead of churning.
//
// Rules (all integer math on the bars seen so far; no clock, no randomness,
// no network, so two runs produce byte-identical action logs):
//   - History: the close of every CBBTC bar, in bar order (a batch with no
//     CBBTC bar contributes nothing, so gaps cannot shift the windows).
//   - BUY with all cash when the current close is >= 50 bps below the mean
//     of the 300 closes before it AND the 240-bar return is >= -100 bps
//     (a guard against buying into a strong downtrend).
//   - HOLD with an 80 bps trailing stop from the highest close since entry;
//     SELL the whole position when the close gives back >= 80 bps from it.
//   - At most one position, at most one order per reply, long only.
//   - Whether a position is held is read from the harness-reported
//     positions on every batch, never assumed: if a buy is ever rejected
//     (slippage, no bar), the bot simply re-decides on the next bar
//     instead of tracking a phantom position.
//   - Warm-up batches build history but never trade (orders on them would
//     be rejected); the first tradable decision needs 300 prior closes.
//
// This is an original strategy: no EMA cross, no RSI/Bollinger, no ADX,
// no fixed-schedule rebalance, no buy-and-hold.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MEAN_BARS = 300; // rolling-mean window, in bars
const GUARD_BARS = 240; // downtrend-guard lookback, in bars
const DIP_BPS = 50; // buy when the close is this far below the mean
const GUARD_BPS = -100; // ... unless the 240-bar return is below this
const TRAIL_BPS = 80; // sell when the close gives back this much from the peak
const MAX_SLIPPAGE_BPS = 300; // far above any 1-minute move + impact on this window

const closes: bigint[] = [];
const prefix: bigint[] = [0n]; // prefix[i] = sum of closes[0..i-1]
let peak = 0n; // highest close since entry (set when a buy is decided)

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // gap batch: no fresh bar, no decision
    const close = BigInt(bar.c);
    const k = closes.length;
    closes.push(close);
    prefix.push(prefix[k] + close);
    if (state.warmingUp) return [];
    if (k < MEAN_BARS) return []; // not enough history for the mean yet
    const mean = (prefix[k] - prefix[k - MEAN_BARS]) / BigInt(MEAN_BARS);
    const heldQty = state.positions.get(SYMBOL)?.qty ?? 0n;
    if (heldQty <= 0n) {
      const dip = ((mean - close) * 10_000n) / mean;
      const guard = (close * 10_000n) / closes[k - GUARD_BARS] - 10_000n;
      if (dip >= BigInt(DIP_BPS) && guard >= BigInt(GUARD_BPS)) {
        const cash = state.cash;
        if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
        peak = close;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    if (peak === 0n) peak = close; // defensive: a position with no recorded entry
    if (close > peak) peak = close;
    const giveback = ((peak - close) * 10_000n) / peak;
    if (giveback >= BigInt(TRAIL_BPS)) {
      return [{ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
