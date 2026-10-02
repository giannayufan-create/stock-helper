// server/src/lib/intl-cache.test.ts
// Run: npx tsx src/lib/intl-cache.test.ts

import assert from 'node:assert/strict';
import { dateTimeFormat } from './intl-cache.ts';

const ymd = { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' } as const;

assert.equal(dateTimeFormat('en-CA', ymd), dateTimeFormat('en-CA', { ...ymd }));
assert.notEqual(dateTimeFormat('en-CA', ymd), dateTimeFormat('en-US', ymd));
assert.equal(
    dateTimeFormat('en-CA', ymd).format(new Date('2026-10-01T16:30:00Z')),
    '2026-10-02',
);
console.log('PASS same_options_reuse_one_formatter');

const before = process.memoryUsage().rss;
for (let i = 0; i < 50_000; i++) dateTimeFormat('en-CA', ymd).format(new Date());
const grownMb = (process.memoryUsage().rss - before) / 1048576;
assert.ok(grownMb < 50, `rss grew ${grownMb.toFixed(0)}MB`);
console.log('PASS hot_loop_does_not_grow_rss');

console.log('\nOK 2 tests');
