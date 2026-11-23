// TrendSurfer — strategy core for the BTC 24h race (cbBTC/USDC, 1-minute bars).
//
// Pure function of price history: no I/O, no clock, no randomness, so two runs on
// the same bars are byte-identical. main.ts wires this into the bars-replay harness;
// backtest.mjs (outside the repo) imports this same file, so the tested logic is
// exactly the shipped logic.
//
// Design (v6 — measured on the dev window + 4 stress windows; backtest fill
// model validated to the cent against grade-local on buy-and-hold):
//   - FIRST ENTRY buys early on short momentum (24-bar return > 0, price above
//     the 48-bar SMA): like the momentum baseline (dev +$34.94, 1 trade), it
//     rides the day's trend from near the start instead of waiting for a
//     slow filter to confirm it (v4's slope filter entered at the top, -$18).
//   - THE ONLY EXIT is a 250 bps trailing stop from the peak close — a circuit
//     breaker, not a trading signal. On the dev day (max drawdown 1.98%) it
//     never fires: the bot holds all day like buy-and-hold (dev +$32.47).
//     On a down day it caps the loss near -2.5% instead of riding the whole
//     -3.6% drop (reversed window: -$23.11 vs buy-and-hold -$38.90).
//   - RE-ENTRY after a stop-out needs a confirmed new uptrend (240-bar SMA +
//     rising slope + 120-bar momentum): dead-cat bounces on a falling day
//     must not buy the bot back in (v5 re-entered on 24-bar momentum and
//     bled -$51.89 on the reversed window; v6: -$23.11, 2 trades).
//   - No fixed take-profit: winners run; the breaker banks them only when the
//     trend really breaks. No momentum-death exit: 1-minute momentum noise
//     must not dump a good position (v1: 32 trades, -$35.16).
// A round trip costs ~26 bps, so a trade must capture a real move to pay for
// itself — this bot trades 1-4 times a day, not 30.

export interface StrategyParams {
  /** Fast EMA length in bars. */
  fast: number;
  /** Slow EMA length in bars. */
  slow: number;
  /** Regime SMA length in bars. */
  regime: number;
  /** Momentum lookback in bars. */
  momLookback: number;
  /** Minimum 120-bar return to enter (fraction, e.g. 0.003 = +0.30%). */
  momMin: number;
  /** 120-bar return below which an open position is closed (fraction). Unused in v2. */
  momDeath: number;
  /** Trailing stop below the peak close since entry, in basis points. Only
   * exits together with a fast-below-slow EMA cross (confirmation). */
  trailBps: number;
  /** Hard stop below the entry close, in basis points. Exits immediately. */
  stopBps: number;
  /** Bars to sit out after an exit before re-entering. */
  cooldownBars: number;
  /** Minimum bars to hold a position before any non-hard-stop exit. */
  minHoldBars: number;
  /** Lookback for the regime-SMA slope (bars). */
  smaSlopeLookback: number;
  /** Minimum rise of the regime SMA over smaSlopeLookback bars (fraction).
   * The discriminator that keeps the bot out of chop: during a real leg the
   * 240-bar SMA climbs steadily; in a flat range it is flat, even while
   * price oscillates around it and short momentum flickers positive. */
  smaSlopeMin: number;
  /** Exit when price closes under the regime SMA. */
  useRegimeExit: boolean;
  /** Exit on trailing stop only together with a fast-below-slow EMA cross.
   * When false, the trailing stop exits on its own. */
  useTrailConfirm: boolean;
  /** Re-entry bar after a circuit-breaker exit: only a confirmed new
   * uptrend gets the bot back in (regime + slope + long momentum). */
  reentryRegime: number;
  reentryMomLookback: number;
  reentryMomMin: number;
  reentrySlopeMin: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  fast: 12,
  slow: 48,
  regime: 48,
  momLookback: 24,
  momMin: 0,
  momDeath: -1,
  trailBps: 250,
  stopBps: 250,
  cooldownBars: 24,
  minHoldBars: 0,
  smaSlopeLookback: 60,
  smaSlopeMin: -1,
  useRegimeExit: false,
  useTrailConfirm: false,
  reentryRegime: 240,
  reentryMomLookback: 120,
  reentryMomMin: 0.003,
  reentrySlopeMin: 0.0015,
};

export type Signal = "buy" | "sell" | "hold";

export interface StrategyState {
  closes: number[];
  emaFast: number;
  emaSlow: number;
  /** Close at which the current position was (approximately) entered. */
  entryPrice: number;
  /** Highest close since entry. */
  peak: number;
  /** Bars the current position has been held. */
  barsHeld: number;
  /** Regime-SMA value per bar (for the slope filter). */
  smaHist: number[];
  /** True once the bot has been stopped out: re-entry then needs the strict filter. */
  exited: boolean;
  /** Bars left in the post-exit cooldown. */
  cooldown: number;
}

export function createState(): StrategyState {
  return { closes: [], emaFast: 0, emaSlow: 0, entryPrice: 0, peak: 0, barsHeld: 0, smaHist: [], exited: false, cooldown: 0 };
}

function emaUpdate(prev: number, close: number, length: number): number {
  const k = 2 / (length + 1);
  return close * k + prev * (1 - k);
}

function sma(closes: number[], length: number, end: number = closes.length): number {
  let sum = 0;
  for (let i = end - length; i < end; i++) sum += closes[i];
  return sum / length;
}

/**
 * Feed one close and get the signal for this bar.
 * `holding` is the bot's real position state (from the harness account).
 * The state is updated in place and returned.
 */
export function decide(
  st: StrategyState,
  close: number,
  holding: boolean,
  p: StrategyParams = DEFAULT_PARAMS,
): Signal {
  st.closes.push(close);
  const n = st.closes.length;

  // Seed the EMAs on the first close; update afterwards.
  if (n === 1) {
    st.emaFast = close;
    st.emaSlow = close;
    return "hold";
  }
  st.emaFast = emaUpdate(st.emaFast, close, p.fast);
  st.emaSlow = emaUpdate(st.emaSlow, close, p.slow);

  // Keep entry/peak in sync with the real position (fills can lag a bar).
  if (!holding) {
    st.entryPrice = 0;
    st.peak = 0;
    st.barsHeld = 0;
  } else {
    if (st.entryPrice === 0) st.entryPrice = close;
    if (close > st.peak) st.peak = close;
    st.barsHeld++;
  }
  if (st.cooldown > 0) st.cooldown--;

  // Not enough history for the regime filter yet.
  if (n < p.regime) return "hold";

  const regimeSma = sma(st.closes, p.regime);
  st.smaHist.push(regimeSma);
  const momThen = st.closes[n - 1 - p.momLookback];
  const mom = momThen > 0 ? close / momThen - 1 : 0;
  // Regime-SMA slope: is the long trend itself still climbing?
  let smaSlope = 0;
  if (st.smaHist.length > p.smaSlopeLookback) {
    const then = st.smaHist[st.smaHist.length - 1 - p.smaSlopeLookback];
    smaSlope = then > 0 ? regimeSma / then - 1 : 0;
  }

  if (!holding) {
    if (st.cooldown > 0) return "hold";
    const uptrend = st.emaFast > st.emaSlow;
    const aboveRegime = close > regimeSma;
    if (!st.exited) {
      // First entry: buy early on short momentum, like the momentum
      // baseline (buy at bar 24, hold). The circuit breaker below is the
      // only exit, so an early entry is cheap.
      if (uptrend && aboveRegime && mom > p.momMin) return "buy";
      return "hold";
    }
    // Re-entry after a stop-out: only a confirmed new uptrend.
    if (n < p.reentryRegime) return "hold";
    const reentrySma = sma(st.closes, p.reentryRegime);
    const reentryMomThen = st.closes[n - 1 - p.reentryMomLookback];
    const reentryMom = reentryMomThen > 0 ? close / reentryMomThen - 1 : 0;
    const reentrySmaThen = sma(st.closes, p.reentryRegime, n - p.smaSlopeLookback);
    const reentrySlope = reentrySmaThen > 0 ? reentrySma / reentrySmaThen - 1 : 0;
    if (uptrend && close > reentrySma && reentrySlope > p.reentrySlopeMin && reentryMom > p.reentryMomMin) return "buy";
    return "hold";
  }

  // Holding: exit only on a CONFIRMED trend death.
  // Hard stop first: it fires at any hold length.
  const stopHit = st.entryPrice > 0 && close < st.entryPrice * (1 - p.stopBps / 10_000);
  if (stopHit) {
    st.cooldown = p.cooldownBars;
    st.exited = true;
    return "sell";
  }
  // Minimum hold: a fresh position cannot be dumped by one noisy bar.
  if (st.barsHeld < p.minHoldBars) return "hold";
  const belowRegime = close < regimeSma;
  const trendDead = st.emaFast < st.emaSlow;
  const trailingHit = st.peak > 0 && close < st.peak * (1 - p.trailBps / 10_000);
  // Regime break exits alone; the trailing stop needs the EMA cross to
  // confirm the trend really turned (a pullback alone is not an exit) —
  // unless useTrailConfirm is off, in which case the trailing stop is the
  // circuit breaker and exits on its own.
  const trailExit = p.useTrailConfirm ? trendDead && trailingHit : trailingHit;
  if ((p.useRegimeExit && belowRegime) || trailExit) {
    st.cooldown = p.cooldownBars;
    st.exited = true;
    return "sell";
  }
  return "hold";
}
