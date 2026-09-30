# Strategy Validation — Phase 3

## Chosen strategy: **OPEN_PASS (`bc-strategy-v1`)**

### Inventory (why this one)

| Candidate | Entry clarity | Frozen inputs | Exit at emission | Notes |
|---|---|---|---|---|
| **OPEN_PASS (B)** | `tradeable_candidate=true` first pass | Rich `feature_snapshot` (A/gap/rvol/vwap/risk) | `invalid_price` / reason only | Best documented gate + lifecycle |
| STRONG_ENTER / C events | State transition / event typed | Intraday metrics | `invalid_price` optional | Fragmented event cooldowns |
| EARLY (radar-rescue) | Shadow rescue path | Separate daily report | Shadow metrics, not StrategySignal | Parallel validation already exists |
| Shadow cohorts | Research only | Context tags | N/A | Not a tradeable strategy version |

**Pick:** OPEN_PASS / `bc-strategy-v1` — richest emission snapshot, clear first-pass lifecycle, already stored via StrategySignalFactory + RawSignalEvent.

### What is original vs provisional

**Original at emission (raw event):**
- Entry: B gate tradeable → OPEN_PASS
- `price_at_signal`, scores, trigger_conditions, key_inputs
- `exit_rules_snapshot.invalid_price` (when risk-gate set it)
- Missing TP / stop-% / max-hold / size → stay missing (never backfill into raw)

**Provisional simulation (labeled `assumptions_not_original_strategy: true`):**
- Fill delay, slippage, TW fees/tax (see `cost-model.ts` as-of constants)
- Provisional TP / stop / max-hold for research P&L only
- Same-bar stop+target → **ambiguous** (not favorable)

### Exit decisions still needed from owner

See `EXIT_DECISIONS_NEEDED` in `types.ts`:
1. take_profit pct or price
2. stop beyond / instead of invalid_price
3. max hold / session exit
4. position size + concurrency (required before portfolio MDD)
5. fill delay + slippage policy
6. day-trade tax eligibility

Until then: **signal-path metrics are primary**; sim P&L is explicitly provisional.

### How to accumulate live records

1. Live B/C → `StrategySignalBridge` → Factory saves StrategySignal **and** appends `RawSignalEvent` to `data/raw_strategy_signals/{ymd}.jsonl`
2. Restart-safe dedupe by `signal_id` (`SKIP_IDEMPOTENT`)
3. Validation API reads raw store + optional bar feed for path/sim

### Disclaimer

No proven edge. No real orders. No A/B/C/BP/Rank mutation.
