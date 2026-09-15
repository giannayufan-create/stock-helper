// server/src/replay-cli.ts
// npm run replay -- --date 2026-06-15 --symbols 2367,2330,2317 --speed max [--synthetic]

import { MockMarketDataProvider } from './providers/mock/market.ts';
import { MarketManager } from './providers/manager.ts';
import {
    formatReplayReport,
    runHistoricalReplay,
} from './lib/historical-replay/index.ts';

function arg(name: string): string | undefined {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx < 0) return undefined;
    return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
    const date = arg('date') ?? '2026-06-15';
    const symbolsRaw = arg('symbols') ?? '2367,2330,2317';
    const symbols = symbolsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const speed = arg('speed') ?? 'max';
    const until = arg('until');
    const synthetic = hasFlag('synthetic') || !process.env.SHIOAJI_API_KEY;

    const manager = new MarketManager();
    const mock = new MockMarketDataProvider();
    await mock.init();
    manager.start(mock, 'mock');

    console.log(
        `replay start date=${date} symbols=${symbols.join(',')} speed=${speed}` +
            (synthetic ? ' [synthetic]' : ''),
    );

    const report = await runHistoricalReplay({
        date,
        symbols,
        speed,
        until,
        synthetic,
        market: manager,
        universe_source: synthetic ? 'synthetic' : 'manual_test',
    });

    console.log('\n' + formatReplayReport(report));
    console.log(`\nreplay_run_id=${report.replay_run_id}`);
    console.log(`status=${report.status} confidence=${report.replay_confidence}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
