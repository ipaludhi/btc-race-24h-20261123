// TrendSurfer — BTC 24h race bot (cbBTC/USDC, 1-minute bars, long only).
//
// Entrypoint: node /bot/main.ts. Speaks agent-fun/bars-replay/v1 through the
// kit SDK shim in vendor/. One asset (CBBTC), at most one open position, 100%
// of cash on entry. Strategy (v6, see strategy.ts): buy early on short
// momentum and hold; the only exit is a 250 bps trailing stop (circuit
// breaker); re-entry after a stop-out needs a confirmed new uptrend.
//
// Determinism: the decision is a pure function of the closes seen so far.
// No clock, no environment, no Math.random — the two graded runs agree.

import { runBars, type BarsState, type OrderInput } from "./vendor/makefun-bars.ts";
import { createState, decide, DEFAULT_PARAMS, type StrategyState } from "./strategy.ts";

const SYMBOL = "CBBTC";
/** Wide enough for normal open-vs-close gaps, tight enough to refuse a disaster fill. */
const MAX_SLIPPAGE_BPS = 100;

const st: StrategyState = createState();

await runBars({
  onBatch(state: BarsState) {
    // Warm-up batches cannot trade; skip them entirely.
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const holding = state.positions.has(SYMBOL);
    const signal = decide(st, Number(close), holding, DEFAULT_PARAMS);
    if (signal === "buy" && !holding) {
      const room = state.weightRoom(SYMBOL);
      const spend = state.cash < room ? state.cash : room;
      if (spend <= 0n || spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      const order: OrderInput = {
        side: "buy",
        symbol: SYMBOL,
        notional_quote_units: spend,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      return [order];
    }
    if (signal === "sell" && holding) {
      const pos = state.positions.get(SYMBOL)!;
      const order: OrderInput = {
        side: "sell",
        symbol: SYMBOL,
        qty: pos.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      return [order];
    }
    return [];
  },
});
