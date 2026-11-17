// Dip-and-ride BTC bot for the make.fun bars-replay race (v3).
//
// Idea: buy dips against a short rolling mean, bank the recovery with a
// take-profit, and keep a wide trailing stop as the fallback exit.
// Turnover stays low on purpose: at dev-window pool depths a full-size
// round trip costs ~35 bps (4 fee + 2 slippage + ~11-13 price impact per
// leg), so the bot only trades when the dislocation is large.
//
// Rules (all integer math on the bars seen so far; no clock, no randomness,
// no network, so two runs produce byte-identical action logs):
//   - History: the close of every CBBTC bar, in bar order (a batch with no
//     CBBTC bar contributes nothing, so gaps cannot shift the windows).
//   - BUY with all cash when the current close is >= 75 bps below the mean
//     of the 75 closes before it AND the 240-bar return is >= -150 bps
//     (a guard against buying into a strong downtrend; the guard is
//     treated as passed until 240 closes exist).
//   - SELL the whole position when either the close has risen >= 190 bps
//     above the entry close (take-profit: bank the recovery) or it has
//     given back >= 100 bps from the highest close since entry (trailing
//     stop: the fallback exit when the recovery never arrives).
//   - At most one position, at most one order per reply, long only.
//   - Whether a position is held is read from the harness-reported
//     positions on every batch, never assumed: if a buy is ever rejected
//     (slippage, no bar), the bot simply re-decides on the next bar
//     instead of tracking a phantom position.
//   - Warm-up batches build history but never trade (orders on them would
//     be rejected); the first tradable decision needs 75 prior closes.
//
// This is an original strategy: no EMA cross, no RSI/Bollinger, no ADX,
// no fixed-schedule rebalance, no buy-and-hold. The take-profit + trailing
// combination banks dip recoveries instead of giving them back to the
// trailing stop alone.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MEAN_BARS = 75; // rolling-mean window, in bars
const GUARD_BARS = 240; // downtrend-guard lookback, in bars
const DIP_BPS = 75; // buy when the close is this far below the mean
const GUARD_BPS = -150; // ... unless the 240-bar return is below this
const TRAIL_BPS = 100; // sell when the close gives back this much from the peak
const TAKE_PROFIT_BPS = 190; // sell when the close rises this much above the entry close
const MAX_SLIPPAGE_BPS = 300; // far above any 1-minute move + impact on this window

const closes: bigint[] = [];
const prefix: bigint[] = [0n]; // prefix[i] = sum of closes[0..i-1]
let peak = 0n; // highest close since entry (set when a buy is decided)
let entry = 0n; // close on the bar the buy was decided (take-profit reference)

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
      const guard = k >= GUARD_BARS ? (close * 10_000n) / closes[k - GUARD_BARS] - 10_000n : 0n;
      if (dip >= BigInt(DIP_BPS) && guard >= BigInt(GUARD_BPS)) {
        const cash = state.cash;
        if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
        peak = close;
        entry = close;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    if (peak === 0n) peak = close; // defensive: a position with no recorded entry
    if (entry === 0n) entry = close;
    if (close > peak) peak = close;
    const giveback = ((peak - close) * 10_000n) / peak;
    const gain = ((close - entry) * 10_000n) / entry;
    if (giveback >= BigInt(TRAIL_BPS) || gain >= BigInt(TAKE_PROFIT_BPS)) {
      return [{ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
