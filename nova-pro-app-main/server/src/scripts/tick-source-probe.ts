// Read-only probe: can Fugle return today's tick-by-tick trades after the close?
// Prints counts, time range and field names only; never prints the API key.
// Run: npx tsx src/scripts/tick-source-probe.ts 2330 2492

import { loadEnvFile } from '../load-env.ts';

const REST = 'https://api.fugle.tw/marketdata/v1.0/stock';

async function probe(apiKey: string, symbol: string): Promise<void> {
    const all: Record<string, unknown>[] = [];
    let date = '';
    const PAGE = 500;
    for (let offset = 0; offset < 200_000; offset += PAGE) {
        const res = await fetch(
            `${REST}/intraday/trades/${symbol}?limit=${PAGE}&offset=${offset}`,
            { headers: { 'X-API-KEY': apiKey }, signal: AbortSignal.timeout(30_000) },
        );
        if (res.status !== 200) {
            console.log(`${symbol}: http_${res.status} at offset ${offset}`);
            return;
        }
        const body = (await res.json()) as { date?: string; data?: Record<string, unknown>[] };
        date = String(body.date ?? '');
        const rows = body.data ?? [];
        all.push(...rows);
        if (rows.length < PAGE) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    const times = all.map((r) => Number(r.time)).filter(Number.isFinite).sort((a, b) => a - b);
    const t = (us: number) => new Date(us / 1000 + 8 * 3_600_000).toISOString().slice(11, 23);
    const early = times.filter((us) => t(us) < '09:10:00.000').length;
    console.log(
        `${symbol}: date=${date} trades=${all.length} first=${times.length ? t(times[0]!) : '-'} ` +
            `last=${times.length ? t(times[times.length - 1]!) : '-'} trades_09:00-09:10=${early}`,
    );
    console.log(`  fields=${Object.keys(all[0] ?? {}).join(',')}`);
    const sizeSum = all.reduce((a, r) => a + Number(r.size || 0), 0);
    const maxVol = Math.max(0, ...all.map((r) => Number(r.volume || 0)));
    const serials = new Set(all.map((r) => r.serial));
    console.log(`  sum(size)=${sizeSum} max(volume)=${maxVol} unique_serials=${serials.size}`);
    const firstOpen = all
        .filter((r) => t(Number(r.time)) >= '09:00:00.000')
        .sort((a, b) => Number(a.time) - Number(b.time))
        .slice(0, 3);
    for (const r of firstOpen) console.log(`  ${t(Number(r.time))} ${JSON.stringify(r)}`);
}

async function main(): Promise<void> {
    loadEnvFile();
    const apiKey = process.env.FUGLE_API_KEY ?? '';
    if (!apiKey) throw new Error('FUGLE_API_KEY missing');
    const symbols = process.argv.slice(2);
    for (const s of symbols.length ? symbols : ['2330']) await probe(apiKey, s);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
