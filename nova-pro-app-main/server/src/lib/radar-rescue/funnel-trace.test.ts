// server/src/lib/radar-rescue/funnel-trace.test.ts
// Run: npx tsx src/lib/radar-rescue/funnel-trace.test.ts

import assert from 'node:assert/strict';
import {
    appendFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FunnelTraceService } from './funnel-trace.ts';

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

function todayYmd(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

function lineCount(file: string): number {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

// ---- flush writes only on transition changes, not score jitter ----
{
    const dir = mkdtempSync(join(tmpdir(), 'funnel-flush-'));
    try {
        const f = new FunnelTraceService(dir);
        const file = join(dir, 'radar_funnel_trace', `${todayYmd()}.jsonl`);
        f.upsert({ symbol: '2330', name: '台積電', in_c: true, c_score: 61 });
        f.upsert({ symbol: '2317', name: '鴻海', in_c: true, c_score: 55 });
        assert.equal(f.flushTransitions(), 2);

        f.upsert({ symbol: '2330', c_score: 63, bp_score: 70 });
        f.upsert({ symbol: '2317', c_score: 54 });
        assert.equal(f.flushTransitions(), 0, 'score-only changes are not appended');

        f.upsert({ symbol: '2330', radar_state: 'ACTIVE' });
        assert.equal(f.flushTransitions(), 1);
        assert.equal(lineCount(file), 3);
        pass('flush_only_on_transition');

        // Restart: restored signature suppresses re-append of unchanged rows
        const f2 = new FunnelTraceService(dir);
        assert.equal(f2.loadToday(), 3);
        assert.equal(f2.get('2330')?.radar_state, 'ACTIVE');
        f2.upsert({ symbol: '2330', c_score: 80 });
        assert.equal(f2.flushTransitions(), 0);
        pass('restart_keeps_flush_signature');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---- chunked load: multi-MB file, multibyte names across chunk edges ----
{
    const dir = mkdtempSync(join(tmpdir(), 'funnel-load-'));
    try {
        const traceDir = join(dir, 'radar_funnel_trace');
        mkdirSync(traceDir, { recursive: true });
        const file = join(traceDir, `${todayYmd()}.jsonl`);
        const pad = '漲'.repeat(97);
        const symbols = Array.from({ length: 50 }, (_, i) => String(1100 + i));
        let batch = '';
        for (let round = 0; round < 400; round++) {
            for (const symbol of symbols) {
                batch +=
                    JSON.stringify({
                        symbol,
                        name: `名稱${symbol}${pad}`,
                        trade_date: todayYmd(),
                        c_score: round,
                        radar_state: round === 399 ? 'ACTIVE' : 'WATCH',
                    }) + '\n';
            }
            if (batch.length > 200_000) {
                appendFileSync(file, batch, 'utf8');
                batch = '';
            }
        }
        appendFileSync(file, batch, 'utf8');

        const f = new FunnelTraceService(dir);
        assert.equal(f.loadToday(), 50 * 400);
        assert.equal(f.list().length, 50);
        for (const symbol of symbols) {
            const row = f.get(symbol)!;
            assert.equal(row.c_score, 399, 'last row per symbol wins');
            assert.equal(row.name, `名稱${symbol}${pad}`, 'utf8 intact across chunks');
            assert.equal(row.ever_active, true);
        }
        pass('chunked_load_last_row_wins_utf8_intact');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---- new Taipei day: no sticky carry-over, yesterday's rows land in yesterday's file ----
{
    const dir = mkdtempSync(join(tmpdir(), 'funnel-roll-'));
    try {
        let now = Date.parse('2026-10-01T15:50:00.000Z'); // 23:50 Taipei
        const f = new FunnelTraceService(dir, () => now);
        f.upsert({ symbol: '2330', in_c: true, early_trigger: true });
        now = Date.parse('2026-10-01T16:10:00.000Z'); // 00:10 next day
        assert.equal(f.get('2330'), null);
        assert.equal(f.list().length, 0);
        const row = f.upsert({ symbol: '2330' });
        assert.equal(row.trade_date, '2026-10-02');
        assert.equal(row.in_c, false);
        assert.equal(row.early_trigger, false);
        f.flushTransitions();
        const traceDir = join(dir, 'radar_funnel_trace');
        assert.equal(lineCount(join(traceDir, '2026-10-01.jsonl')), 1);
        assert.equal(lineCount(join(traceDir, '2026-10-02.jsonl')), 1);
        pass('day_rollover_resets_and_files_by_trade_date');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

console.log(`\nOK ${passed} tests`);
