// server/src/lib/live-acceptance/runtime-timeline.test.ts
// Run: npx tsx src/lib/live-acceptance/runtime-timeline.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRuntimeTimeline } from './runtime-timeline.ts';

async function main(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'));
    try {
        const file = join(dir, '2026-10-02.jsonl');
        const rows = [
            { kind: 'runtime', at: '2026-10-02T01:00:00.000Z', rss_mb: 300, heap_mb: 80, event_loop_lag_ms: 2 },
            { kind: 'coverage', at: '2026-10-02T01:00:02.000Z' },
            { kind: 'runtime', at: '2026-10-02T01:00:05.000Z', rss_mb: 420, heap_mb: 95, event_loop_lag_ms: 900 },
            { kind: 'runtime', at: '2026-10-02T01:04:00.000Z', rss_mb: 250, heap_mb: 60, event_loop_lag_ms: 0 },
        ];
        writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\nnot json\n`);
        const tl = await readRuntimeTimeline(file);
        assert.equal(tl.samples, 3);
        assert.equal(tl.minutes.length, 2);
        assert.equal(tl.minutes[0]!.minute, '09:00');
        assert.equal(tl.minutes[0]!.rss_mb_max, 420);
        assert.equal(tl.minutes[0]!.lag_ms_max, 900);
        assert.equal(tl.gaps.length, 1);
        assert.equal(tl.gaps[0]!.seconds, 235);

        const missing = await readRuntimeTimeline(join(dir, 'nope.jsonl'));
        assert.equal(missing.file_exists, false);
        console.log('runtime-timeline tests: OK');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

void main().catch((err) => {
    console.error(err);
    process.exit(1);
});
